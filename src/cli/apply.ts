import { resolve } from 'node:path';
import { parseSirFile } from '../core/sir-parser.ts';
import { ConfigError } from '../core/errors.ts';
import { applyAll } from '../core/apply.ts';
import type { AppliedEdit } from '../core/apply.ts';
import type { SirFile } from '../core/ast.ts';
import { ensureParent, isFile, readIfReadable, readInputFile, replacesFile, writeFileAtomic } from '../infra/fs.ts';
import { resolveOutPath } from '../infra/out-path.ts';
import { isPatchPath, pairOf } from '../infra/pair.ts';
import { loadProject } from '../infra/project.ts';
import type { Project } from '../infra/project.ts';
import { basesOnGit, gitSourceOf } from '../infra/config/index.ts';
import type { ResolvedConfig } from '../infra/config/index.ts';
import { fileFromGit } from '../infra/git.ts';
import { pickAdapter } from '../lang/adapter.ts';
import type { LanguageAdapter } from '../lang/source-map.ts';
import type { ErrorContext, Logger } from '../infra/log.ts';
import type { ArgSpec } from './args.ts';
import { runCommand } from './command.ts';
import { GIT_ARGS, GIT_FLAG_NAMES, GIT_USAGE, asksGit, gitEol, readFromGit } from './git-source.ts';
import type { FileVersion, GitOptions } from './git-source.ts';
import { CONFIRM_ARGS, CONFIRM_USAGE, terminalAsker } from './confirm.ts';
import type { ConfirmOptions } from './confirm.ts';
import type { Ask } from '../infra/ask.ts';
import { answersFrom } from './prompt.ts';

/** Who runs the apply: `sir apply`, a person's tool — or `sir-apply`, a build's,
 *  which asks nothing and patches only a base out of git (or one it is told is clean). */
export type ApplyMode = 'sir' | 'sir-apply';

export interface Options extends GitOptions, ConfirmOptions {
  match?: string;
  in?: string;
  out?: string;
  log?: string;
  language?: string;
  config?: string;
  useConfig: boolean;
  baseFromDisk: boolean;
  dryRun: boolean;
  verify: boolean;
  help: boolean;
}

const USAGE = `sir apply — apply a .sirp patch to a source file

  --match, -m <file>      the patch, a .sirp file (match/patch hunks) [required]
  --in,    -i <file>      the file to patch. Left out, it is the file the patch names
                          in its Target — from the upstream root of the project
                          (sir.config.json up from the patch), else from the
                          repository around the patch.
                          Read from disk — unless a git coordinate below is named:
                          then only its PATH is used (the repository, the default
                          path inside it, the name of the result), the content comes
                          out of git, and the file need not exist on disk at all

${GIT_USAGE}

${CONFIRM_USAGE}

  --out,   -o <path>      where to write the result   [required unless --dry-run/--verify]
                          a directory (existing, or ending with a slash) gets
                          <name of --in> inside it; any other path is written as is
                          and overwritten. Missing directories are created, and a
                          relative path is measured from the repository root.
                          \`-\` writes to stdout. Writing over --in itself while its
                          content came out of git ASKS first when that would lose what
                          --in holds now (see --yes) — and does not ask when --in had
                          the git text anyway, or the result is --in itself
  --language, -l <lang>   force language (else: '# match <lang>' in the patch, else
                          the file extension)
  --dry-run               show planned edits, write nothing
  --verify                exit code only (0 = applies cleanly), write nothing. A check
                          is against a clean base: from git — the flags above, else
                          generate.base of the config. With neither, a person at a
                          terminal is asked whether the files on disk are that base;
                          with nobody to ask it is refused (see --base-from-disk)
  --base-from-disk        --verify against the files on disk as they are, without
                          asking: they are the clean base
  --config <file>         the config to use instead of the one up from the patch
  --no-config             read no config: --in is then required
  --log [place]           also write a full log. A place that is a directory (or ends
                          in /) receives a generated name, so every run gets its own
                          file; any other place IS the name and is overwritten.
                          Omitted → ./sir-logs/. A log that cannot be opened is a
                          warning, not a failure: the run goes on without it
  --help,  -h             this help`;

/** Exported for `sir-apply`, whose options are picked out of these (F2). */
export const SPEC: ArgSpec<Options> = {
  flags: {
    ...GIT_ARGS.flags,
    ...CONFIRM_ARGS.flags,
    '--dry-run': 'dryRun',
    '--verify': 'verify',
    '--base-from-disk': 'baseFromDisk',
    '--help': 'help',
    '-h': 'help',
  },
  values: {
    ...GIT_ARGS.values,
    '--match': 'match', '-m': 'match',
    '--in': 'in', '-i': 'in',
    '--out': 'out', '-o': 'out',
    '--language': 'language', '-l': 'language',
    '--config': 'config',
  },
  negated: { '--no-config': 'useConfig' },
  optional: { '--log': 'log' },
};

export const INITIAL: Options = {
  head: false,
  yes: false,
  useConfig: true,
  baseFromDisk: false,
  dryRun: false,
  verify: false,
  help: false,
};

function describeEdit(applied: AppliedEdit, index: number, total: number): string {
  const { edit, oldText } = applied;
  const kind = edit.start === edit.end ? 'INSERT' : 'REPLACE';
  const where = edit.start === edit.end ? `@${edit.start}` : `[${edit.start}, ${edit.end})`;
  const old = edit.start === edit.end ? '' : `\n    old: ${JSON.stringify(oldText)}`;
  return `hunk ${index + 1}/${total}:\n  ${kind} ${where}\n    new: ${JSON.stringify(edit.text)}${old}`;
}

/** One run of `apply`: everything its steps decide by. */
interface ApplyRun {
  readonly opts: Options;
  readonly mode: ApplyMode;
  /** the file of code: `--in`, or the one the patch names */
  readonly inPath: string;
  readonly file: SirFile;
  readonly adapter: LanguageAdapter;
  readonly config: ResolvedConfig;
  readonly log: Logger;
  readonly seen: Seen;
  readonly ask: Ask;
}

/** The file to patch: the one on disk, or — once any coordinate is named — its version
 *  out of git, with `--in` reduced to naming WHICH file that is. */
async function sourceOf(run: ApplyRun): Promise<FileVersion> {
  const { opts, inPath, ask } = run;
  return asksGit(opts) ? readFromGit(opts, inPath, ask) : { text: readInputFile(inPath, '--in'), spec: inPath };
}

/** What `--verify` checks against — and everything `sir-apply` patches: a clean base.
 *  Out of git when the flags or the config's generate.base name it; the files on disk
 *  only when the person says they are that base — `--base-from-disk`, or yes to the
 *  question `sir` asks and `sir-apply` never does. */
async function verifiedBase(run: ApplyRun): Promise<FileVersion> {
  const { opts, inPath, ask, config, mode, log } = run;
  if (asksGit(opts)) return readFromGit(opts, inPath, ask);
  if (basesOnGit(config.generate)) {
    return fileFromGit({ ...gitSourceOf(config.generate), path: opts.repoPath }, inPath, ask);
  }
  const fromDisk = (): FileVersion => ({ text: readInputFile(inPath, '--in'), spec: inPath });
  if (opts.baseFromDisk) {
    log.note(`warning: --base-from-disk: ${inPath} is taken as the clean base, as it is on disk`);
    return fromDisk();
  }
  if (mode === 'sir-apply') {
    throw new ConfigError(
      `no base — name it (${GIT_FLAG_NAMES} or generate.base), ` +
        'or confirm the files on disk are the clean base: --base-from-disk',
    );
  }
  if (await ask(`--verify names no base out of git: are the files on disk the clean base to check against?`)) {
    return fromDisk();
  }
  throw new Error(
    `--verify needs a clean base: name it in git (${GIT_FLAG_NAMES}, or generate.base in the config), ` +
      'or pass --base-from-disk when the files on disk are it',
  );
}

/** Writing the result over the file of code while its content came out of git puts the
 *  patched git version where the working file is. Nothing is lost when the working file
 *  held the git text to begin with, or already holds the result. Anything else throws
 *  away what the file holds now: `sir` asks first; `sir-apply` writes over it and
 *  says so — the files of the code a build patches are not the project's to keep, and
 *  a patch that changed is laid on the clean base again (docs: prebuild §2). */
async function mustKeepLocalEdits(run: ApplyRun, target: string, source: FileVersion, result: string): Promise<void> {
  const file = resolve(run.inPath);
  if (!isFile(file) || !replacesFile(target, file)) return;
  const onDisk = readInputFile(file, '--in');
  if (onDisk === source.text || onDisk === result) return;
  if (run.mode === 'sir-apply') {
    run.log.note(`note: ${run.inPath} held changes ${source.spec} does not — written over with the patched ${source.spec}`);
    return;
  }
  const question =
    `writing over ${run.inPath}: it holds changes that ${source.spec} does not, and the patched ` +
    `${source.spec} takes its place — whatever of its current content is not committed is lost`;
  if (await run.ask(question)) return;
  throw new Error(
    `the result would go over ${run.inPath}, which holds changes that ${source.spec} does not: ` +
      `writing the patched ${source.spec} there would lose them\n` +
      '  write the result elsewhere (--out), or patch the file as it is on disk (no git coordinate)',
  );
}

async function run(opts: Options, log: Logger, seen: Seen): Promise<void> {
  return runApply(opts, log, seen, 'sir');
}

export async function runApply(opts: Options, log: Logger, seen: Seen, mode: ApplyMode): Promise<void> {
  if (opts.match === undefined) throw new Error('missing --match <file.sirp>');
  if (!isPatchPath(opts.match)) {
    throw new Error(`--match ${opts.match}: a patch is a .sirp file (a .md of sir 0.3 and older: rename it, git mv x.md x.sirp)`);
  }
  const cleanBase = opts.verify || mode === 'sir-apply';
  if (opts.baseFromDisk && (!cleanBase || asksGit(opts))) {
    throw new Error('--base-from-disk names the base of --verify, and only when no git coordinate does');
  }
  const willWrite = !opts.dryRun && !opts.verify;
  // sir-apply without --out patches the file in place
  if (willWrite && opts.out === undefined && mode === 'sir') {
    throw new Error('missing --out <file> (or use --dry-run / --verify)');
  }
  gitEol(opts.eol);
  if (opts.eol !== undefined && !asksGit(opts)) {
    throw new Error(`--eol sets the line endings of a version read out of git, and none is named: add ${GIT_FLAG_NAMES}, or drop --eol`);
  }

  const text = readInputFile(opts.match, '--match');
  const file = parseSirFile(text);
  const { config, project } = loadProject({
    path: opts.match,
    search: { explicitPath: opts.config, cwd: process.cwd(), isPatch: true },
    useFile: opts.useConfig,
  });
  const inPath = opts.in ?? codeOfPatch(opts.match, text, config, project);
  const adapter = pickAdapter({ language: opts.language, heading: file.language, path: inPath });
  await adapter.init();

  const base = { opts, mode, inPath, file, adapter, config, log, seen };
  if (mode === 'sir-apply') {
    // nobody to answer in a build: every question is a refusal, said out loud
    const ask: Ask = (question) => {
      log.note(`warning: ${question}\n  sir-apply asks nothing: stopping`);
      return Promise.resolve(false);
    };
    await applyWith({ ...base, ask });
    return;
  }
  const answers = answersFrom();
  try {
    await applyWith({ ...base, ask: terminalAsker(opts.yes, (m) => log.note(m), answers) });
  } finally {
    answers.close();
  }
}

/** `--in` left out: the file the patch names, as `pair` finds it. */
function codeOfPatch(match: string, text: string, config: ResolvedConfig, project: Project): string {
  const pair = pairOf(match, { out: config.generate.out, project }, text);
  if (pair.kind === 'patch' && pair.code !== null) {
    if (pair.exists) return pair.code;
    // the patch says which file — or its name and place do — and that file is not there
    const how = pair.how === 'target' ? 'its Target names' : 'by its name and place it would be';
    throw new Error(`missing --in <file>: the patch is for ${pair.code} (${how}), and there is no such file — give --in`);
  }
  const why = pair.reason !== undefined ? ` (${pair.reason})` : '';
  throw new Error(`missing --in <file>: the patch names no file it is for${why} — give --in`);
}

async function applyWith(run: ApplyRun): Promise<void> {
  const { opts, inPath, file, adapter, log, seen } = run;
  const source = opts.verify || run.mode === 'sir-apply' ? await verifiedBase(run) : await sourceOf(run);
  seen.source = source;
  log.trace(`source: ${source.spec} (${source.text.length} bytes), ${file.hunks.length} hunk(s)`);
  const { source: result, edits } = applyAll(source.text, file, adapter);

  if (opts.dryRun) {
    for (const [i, e] of edits.entries()) log.info(describeEdit(e, i, edits.length));
    log.info(`dry-run: ${edits.length} hunk(s) would apply (nothing written)`);
    return;
  }
  if (opts.verify) {
    log.info(`verify: ok — ${edits.length} hunk(s) apply cleanly`);
    return;
  }
  // `--out` relative is measured from the repository root (USAGE); the file itself, when
  // the result goes back into it, is where --in named it — from the current directory
  const target = resolveOutPath({ inPath, out: opts.out ?? resolve(inPath), suffix: '' }).path;
  if (target === undefined) {
    process.stdout.write(result);
    log.note(`applied ${edits.length} hunk(s) → stdout`);
    return;
  }
  // a file that already holds the result is left as it is: no new mtime for a build to
  // recompile it over
  if (readIfReadable(target) === result) {
    log.info(`applied ${edits.length} hunk(s) → ${target} (already so: not written)`);
    return;
  }
  if (source.spec !== inPath) await mustKeepLocalEdits(run, target, source, result);
  ensureParent(target);
  writeFileAtomic(target, result);
  log.info(`applied ${edits.length} hunk(s) → ${target}`);
}

export interface Seen {
  source?: FileVersion;
}

export function main(argv: readonly string[]): Promise<void> {
  return runCommand({ name: 'apply', usage: USAGE, spec: SPEC, initial: INITIAL, run, errorContext }, argv);
}

export function errorContext(opts: Options, seen: Seen): ErrorContext {
  const ctx: { source?: string; sourcePath?: string; patchPath?: string } = {};
  if (seen.source !== undefined) {
    ctx.source = seen.source.text;
    ctx.sourcePath = seen.source.spec;
  } else if (opts.in !== undefined) {
    ctx.sourcePath = opts.in;
  }
  if (opts.match !== undefined) ctx.patchPath = opts.match;
  return ctx;
}
