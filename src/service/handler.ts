import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LanguageAdapter } from '../lang/source-map.ts';
import type { ResolveResult } from '../core/resolve.ts';
import type {
  ApplyParams,
  ApplyResultMessage,
  BaseParams,
  CancelParams,
  CancelResult,
  ConfigTemplateParams,
  ConfigTemplateResult,
  BaseInfo,
  ConfigParams,
  ConfigResult,
  GenerateParams,
  GenerateResult,
  LanguageParams,
  OverridesParams,
  PairParams,
  PairResult,
  ProgressMessage,
  RequestMessage,
  ResolveParams,
  ResolveResultMessage,
  ResponseMessage,
  ServiceError,
  VersionResult,
} from './protocol.ts';
import { PROTOCOL_MIN, PROTOCOL_VERSION } from './protocol.ts';
import { parseSirFile } from '../core/sir-parser.ts';
import { FORMAT_MIN } from '../core/header.ts';
import { resolveHunks } from '../core/resolve.ts';
import { GitError, SirError, NoChanges } from '../core/errors.ts';
import { generatePatch, patchHeader } from '../generate/pipeline.ts';
import { trailingSpaceWarningsAt } from '../generate/printer.ts';
import { pickAdapter, pickedAdapter, supportedLanguages } from '../lang/adapter.ts';
import { checkParent, findRepoRoot, isDirectory, isFile } from '../infra/fs.ts';
import { fileFromGit, gitBaseOf, headRefFiles } from '../infra/git.ts';
import { resolveOutPath } from '../infra/out-path.ts';
import type { Project } from '../infra/project.ts';
import { isPatchPath, pairOf, patchAt, patchTarget } from '../infra/pair.ts';
import {
  CONFIG_MIN,
  CONFIG_VERSION,
  configCandidates,
  configTemplate,
  schemaVersions,
  suggestedConfigPath,
} from '../infra/config/index.ts';
import type { ResolvedConfig } from '../infra/config/index.ts';
import { baseChoice, checkOverrides, settingsFor } from './settings.ts';
import type { BaseChoice } from './settings.ts';
import { BadRequest, NOT_A_REQUEST, absolutePath, checkTypes, decode, requestShape } from './request.ts';
import type { ParamSpec } from './request.ts';
import { packageIdentity } from '../infra/version.ts';

export type Emit = (message: ProgressMessage) => void;

export class Cancelled extends Error {
  constructor(id: number) {
    super(`request ${id} was cancelled`);
    this.name = 'Cancelled';
  }
}

export class Session {
  private readonly running = new Map<number, AbortController>();

  start(id: number): AbortSignal {
    const control = new AbortController();
    this.running.set(id, control);
    return control.signal;
  }

  end(id: number, signal: AbortSignal): void {
    if (this.running.get(id)?.signal === signal) this.running.delete(id);
  }

  cancel(id: number): boolean {
    const control = this.running.get(id);
    if (control === undefined) return false;
    control.abort(new Cancelled(id));
    return true;
  }
}

export async function handle(message: unknown, emit?: Emit, session: Session = new Session()): Promise<ResponseMessage> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const { id, message: request } = requestShape(message);
  if (request === null) {
    return { id, ok: false, error: toServiceError(new BadRequest(NOT_A_REQUEST)), elapsedMs: elapsed() };
  }
  // `cancel` is not itself cancellable: registered, it could shadow the request it names
  const signal = request.method === 'cancel' ? undefined : session.start(id);
  try {
    const result = await dispatch(request, { id, emit, session, signal });
    return { id, ok: true, result, elapsedMs: elapsed() };
  } catch (e) {
    return { id, ok: false, error: toServiceError(e), elapsedMs: elapsed() };
  } finally {
    if (signal !== undefined) session.end(id, signal);
  }
}

interface Call {
  readonly id: number;
  readonly emit: Emit | undefined;
  readonly session: Session;
  readonly signal: AbortSignal | undefined;
}

interface Method {
  readonly params: ParamSpec | null;
  readonly run: (params: never, call: Call) => unknown;
}

function method<T>(params: ParamSpec | null, run: (params: T, call: Call) => unknown): Method {
  return { params, run: run as Method['run'] };
}

const LANGUAGE: ParamSpec = { language: 'string', path: 'string', allowDownload: 'boolean' };
const BASE: ParamSpec = { baseText: 'string', baseGit: 'object' };
const SETTINGS: ParamSpec = { language: 'string', limits: 'object', configPath: 'string' };
const OVERRIDES: ParamSpec = { ...SETTINGS, baseGit: 'object', base: 'string' };

// A Map, not an object literal: the method name is whatever the client sent, and an
// object answers `constructor` and `__proto__` with what it inherits. Its order is the
// order the "known:" list names them in.
const METHODS: ReadonlyMap<string, Method> = new Map([
  ['version', method(null, () => version())],
  ['generate', method<GenerateParams>({ ...LANGUAGE, ...BASE, ...SETTINGS, newText: 'string', keep: 'string' }, (p, call) => generate(p, call))],
  ['resolve', method<ResolveParams>({ ...LANGUAGE, ...BASE, patch: 'string', configPath: 'string' }, (p) => resolve(p))],
  ['apply', method<ApplyParams>({ ...LANGUAGE, ...BASE, patch: 'string', configPath: 'string' }, (p) => apply(p))],
  ['configTemplate', method<ConfigTemplateParams>({ path: 'string', version: 'number', settings: 'object' }, (p) => configTemplateOf(p))],
  ['config', method<ConfigParams>({ path: 'string', configPath: 'string', overrides: 'object' }, (p) => configOf(p))],
  ['pair', method<PairParams>({ path: 'string', patch: 'string', configPath: 'string', overrides: 'object' }, (p) => pairFor(p))],
  ['cancel', method<CancelParams>({ id: 'number' }, (p, call) => cancel(p, call.session))],
]);

function dispatch(message: RequestMessage, call: Call): unknown {
  const found = METHODS.get(message.method);
  if (found === undefined) {
    throw new BadRequest(`unknown method '${String(message.method)}'; known: ${[...METHODS.keys()].join(', ')}`);
  }
  return found.run((found.params === null ? undefined : decode(message, found.params)) as never, call);
}

function cancel(p: CancelParams, session: Session): CancelResult {
  if (p.id === undefined) throw new BadRequest('params.id must be the number of the request to cancel');
  return { cancelled: session.cancel(p.id) };
}

function version(): VersionResult {
  return {
    sir: packageIdentity().version,
    protocol: PROTOCOL_VERSION,
    protocolMin: PROTOCOL_MIN,
    configSchema: CONFIG_VERSION,
    configSchemaMin: CONFIG_MIN,
    languages: supportedLanguages,
  };
}

async function generate(p: GenerateParams, call: Call): Promise<GenerateResult> {
  text(p.newText, 'newText');
  absolutePath(p.path);
  exactlyOneBase(p);

  const o = generateOverrides(p);
  const { config, project } = settingsFor(p.path, o);
  const settings = config.generate;
  const out =
    p.path === undefined ? null : resolveOutPath({ inPath: p.path, out: settings.out, project }).path ?? null;
  if (out !== null) checkParent(out);
  const target = p.path === undefined ? undefined : patchTarget(project, out ?? undefined, p.path);
  const there = out !== null ? patchAt(out) : { exists: false, target: null };
  const base = await baseOf(baseChoice(settings, o), p);
  const { emit, id } = call;

  let outcome;
  try {
    outcome = await generatePatch({
      oldText: base.text,
      newText: p.newText,
      language: settings.language ?? undefined,
      path: p.path,
      exact: settings.exact,
      bridgeGap: settings.bridgeGap,
      limits: settings,
      provenance: true,
      target,
      baseBlob: base.blob,
      signal: call.signal,
      keep: p.keep,
      ...(emit !== undefined
        ? { onProgress: (done: number, total: number) => emit({ method: 'progress', params: { id, done, total } }) }
        : {}),
    });
  } catch (e) {
    if (e instanceof NoChanges) throw new NoChanges(e.message, base.spec);
    throw e;
  }

  return {
    patch: outcome.md,
    baseSpec: base.spec,
    language: outcome.language,
    warnings: outcome.warnings,
    warningsAt: outcome.warningsAt,
    hunks: outcome.links ?? [],
    reproducesNew: outcome.reproducesNew === true,
    outPath: out,
    outExists: there.exists,
    outTarget: there.target,
    config: applied(config),
  };
}

function generateOverrides(p: GenerateParams): OverridesParams {
  const { newText, baseText, path, allowDownload, keep, ...settings } = p;
  return { ...settings, ...(baseText !== undefined ? { base: 'text' as const } : {}) };
}

function applied(config: ResolvedConfig): GenerateResult['config'] {
  return { file: config.file ?? null, settings: config.generate, origins: config.origins };
}

function exactlyOneBase(p: BaseParams): void {
  if (p.baseText !== undefined && p.baseGit !== undefined) throw noBase();
}

function noBase(): BadRequest {
  return new BadRequest(
    'send exactly one base: params.baseText (the old version as text), or params.baseGit ' +
      '(the old version out of git — {} for the last commit of the branch you are on)',
  );
}

async function baseOf(choice: BaseChoice | null, p: BaseParams & LanguageParams): Promise<Base> {
  if (choice === null) throw noBase();
  if (choice.kind === 'text') {
    text(p.baseText, 'baseText');
    return { text: p.baseText, spec: null };
  }
  const version = await fileFromGit(choice.source, needsPath(p));
  return { text: version.text, spec: version.spec, blob: version.blob };
}

function needsPath(p: LanguageParams): string {
  if (p.path === undefined) {
    throw new BadRequest(
      'params.baseGit needs params.path: the repository is found from it, and it names the ' +
        'file to read inside that repository unless baseGit.repoPath says otherwise',
    );
  }
  return p.path;
}

interface Base {
  readonly text: string;
  readonly spec: string | null;
  readonly blob?: string;
}

async function resolve(p: ResolveParams): Promise<ResolveResultMessage> {
  const { result, base, facts } = await resolveRequest(p);
  return { hunks: result.links, baseSpec: base.spec, ...(base.spec !== null ? { baseText: base.text } : {}), ...facts };
}

async function apply(p: ApplyParams): Promise<ApplyResultMessage> {
  const { result, base, facts } = await resolveRequest(p);
  return { text: result.applied, hunks: result.links, baseSpec: base.spec, ...facts };
}

async function resolveRequest(
  p: ResolveParams,
): Promise<{ result: ResolveResult; base: Base; facts: Omit<ResolveResultMessage, 'hunks' | 'baseSpec' | 'baseText'> }> {
  absolutePath(p.path);
  exactlyOneBase(p);
  const byPatch = p.path !== undefined && isPatchPath(p.path);
  let patchText: string;
  if (p.patch !== undefined || !byPatch) {
    text(p.patch, 'patch');
    patchText = p.patch;
  } else {
    patchText = readPatch(p.path!);
  }
  const file = parseSirFile(patchText);
  const code = byPatch ? codeNamedBy(p.path!, patchText, p.configPath) : p.path;
  const at: ResolveParams = code === undefined ? p : { ...p, path: code };
  const base = await baseOf(patchedBase(at, byPatch ? p.path : code), at);
  const adapter = await ready(at, file.language);
  const facts = {
    header: file.header ?? { format: FORMAT_MIN },
    code: code ?? null,
    warningsAt: trailingSpaceWarningsAt(file.hunks, patchText),
  };
  return { result: resolveHunks(base.text, file, adapter), base, facts };
}

function readPatch(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new BadRequest(`params.path ${path}: cannot read the patch (${(e as Error).message}) — send its text as params.patch`);
  }
}

function codeNamedBy(patchPath: string, patchText: string, configPath: string | undefined): string {
  const { config, project } = settingsFor(patchPath, configPath !== undefined ? { configPath } : {});
  const pair = pairOf(patchPath, { out: config.generate.out, project }, patchText);
  if (pair.kind === 'patch' && pair.code !== null) return pair.code;
  throw new BadRequest(
    `${patchPath} names no file it is for (${pair.reason ?? 'no Target'}): send the file of code as params.path and the patch as params.patch`,
  );
}

function patchedBase(p: ResolveParams, configAnchor: string | undefined): BaseChoice | null {
  if (p.baseText !== undefined) return { kind: 'text' };
  if (p.baseGit !== undefined) {
    const o: OverridesParams = { baseGit: p.baseGit, ...(p.configPath !== undefined ? { configPath: p.configPath } : {}) };
    return baseChoice(settingsFor(undefined, o).config.generate, o);
  }
  if (configAnchor === undefined) return null;
  const o: OverridesParams = p.configPath !== undefined ? { configPath: p.configPath } : {};
  return baseChoice(settingsFor(configAnchor, o).config.generate, o);
}

async function ready(p: LanguageParams, fromHeading: string | undefined): Promise<LanguageAdapter> {
  const adapter = pickAdapter({ language: p.language, heading: fromHeading, path: p.path });
  await adapter.init();
  return adapter;
}

function configTemplateOf(p: ConfigTemplateParams): ConfigTemplateResult {
  requiredPath(p.path, 'the file or folder the config is for — the repository root is found from it');
  const template = configTemplate({ version: p.version, settings: p.settings });
  const suggestedPath = suggestedConfigPath(isDirectory(p.path) ? p.path : dirname(p.path));
  return {
    text: template.text,
    version: template.version,
    suggestedPath,
    exists: isFile(suggestedPath),
    versions: schemaVersions(),
  };
}

async function configOf(p: ConfigParams): Promise<ConfigResult> {
  requiredPath(p.path, 'the file (code or .sirp) the settings are for');
  const o = withConfigPath(overridesOf(p.overrides), p.configPath);
  const { config, project } = settingsFor(p.path, o);
  const choice = baseChoice(config.generate, o);
  const paired = isPatchPath(p.path) ? pairOf(p.path, { out: config.generate.out, project }) : undefined;
  const basePath = paired === undefined ? p.path : paired.kind === 'patch' ? paired.code : null;

  let base: BaseInfo | null = null;
  let baseBlob: string | undefined;
  const watch = configCandidates(dirname(p.path));
  if (config.file !== undefined && !watch.includes(config.file)) watch.push(config.file);
  if (choice?.kind === 'text') base = { kind: 'text' };
  else if (choice?.kind === 'git' && basePath !== null) {
    try {
      const git = await gitBaseOf(choice.source, basePath);
      base = { kind: 'git', spec: git.spec, sha: git.sha, eol: choice.source.eol ?? 'repository' };
      baseBlob = git.blob;
      watch.push(...git.watch);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      base = { kind: 'unavailable', error: toServiceError(e) };
      watch.push(...(await headRefFiles(basePath)));
    }
  }

  const adapter = basePath === null ? null : pickedAdapter({ language: config.generate.language ?? undefined, path: basePath });
  const target = targetOfPair(p.path, config, project);
  return {
    ...applied(config),
    schemaVersion: config.schemaVersion,
    repoRoot: findRepoRoot(dirname(p.path)) ?? null,
    projectRoot: project.projectRoot ?? null,
    upstreamRoot: project.upstreamRoot,
    target,
    language: adapter?.name ?? null,
    header: basePath === null ? null : patchHeader({ adapter: adapter ?? undefined, target: target ?? undefined, baseBlob }),
    base,
    watch,
  };
}

function targetOfPair(path: string, config: ResolvedConfig, project: Project): string | null {
  try {
    if (isPatchPath(path)) return patchAt(path).target;
    const out = resolveOutPath({ inPath: path, out: config.generate.out, project }).path;
    return patchTarget(project, out, path) ?? null;
  } catch {
    return null;
  }
}

function pairFor(p: PairParams): PairResult {
  requiredPath(p.path, 'the file of code or the .sirp to pair');
  const { config, project } = settingsFor(p.path, withConfigPath(overridesOf(p.overrides), p.configPath));
  return pairOf(p.path, { out: config.generate.out, project }, p.patch);
}

function withConfigPath(o: OverridesParams, configPath: string | undefined): OverridesParams {
  if (configPath === undefined) return o;
  if (o.configPath !== undefined && o.configPath !== configPath) {
    throw new BadRequest('params.configPath and params.overrides.configPath name two configs');
  }
  return { ...o, configPath };
}

function overridesOf(value: OverridesParams | undefined): OverridesParams {
  if (value === undefined) return {};
  checkTypes(value as Readonly<Record<string, unknown>>, OVERRIDES, 'params.overrides');
  checkOverrides(value, 'params.overrides');
  return value;
}

function requiredPath(path: string | undefined, what: string): asserts path is string {
  if (path === undefined || path === '') throw new BadRequest(`params.path must be the absolute path of ${what}`);
  absolutePath(path);
}

function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new BadRequest(`params.${name} must be a string`);
}

function toServiceError(e: unknown): ServiceError {
  if (e instanceof BadRequest) {
    return { kind: 'BadRequest', message: e.message, exitCode: 1 };
  }
  if (e instanceof Cancelled) {
    return { kind: 'Cancelled', message: e.message, exitCode: 1 };
  }
  if (e instanceof SirError) {
    const detail = e.hunkAt === undefined ? e.detail() : { ...e.detail(), ...e.hunkAt };
    return {
      kind: e.name,
      message: e.message,
      exitCode: e.exitCode,
      ...(detail !== undefined ? { detail } : {}),
    };
  }
  return {
    kind: e instanceof Error ? e.name : 'Error',
    message: e instanceof Error ? e.message : String(e),
    exitCode: 1,
  };
}
