import type { Hunk } from '../core/ast.ts';
import type { HunkLink } from '../core/resolve.ts';
import type { MapCache } from '../lang/source-map.ts';
import type { PartialLimits, Tracer } from './synth.ts';
import { parseSirFile } from '../core/sir-parser.ts';
import { resolveHunks } from '../core/resolve.ts';
import { checkHeading, pickAdapter } from '../lang/adapter.ts';
import { printSirFile, trailingSpaceWarnings, trailingSpaceWarningsAt } from './printer.ts';
import type { HunkWarning } from './printer.ts';
import { NoChanges, SynthesisError } from '../core/errors.ts';
import type { SynthesisDraft } from '../core/errors.ts';
import { printHeader } from '../core/header.ts';
import type { GrammarSource, LanguageAdapter } from '../lang/source-map.ts';
import { packageIdentity } from '../infra/version.ts';
import { synthesizeAsync } from './synth.ts';
import { hunksOf, steerSynthesis, unattended } from './steer.ts';
import type { Steering } from './steer.ts';

export interface GenerateRequest {
  readonly oldText: string;
  readonly newText: string;
  readonly language?: string | undefined;
  readonly path?: string | undefined;
  readonly label?: string | undefined;
  readonly exact?: boolean | undefined;
  readonly bridgeGap?: number | undefined;
  readonly limits?: PartialLimits | undefined;
  readonly trace?: Tracer | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
  readonly review?: ((hunks: readonly Hunk[]) => Promise<Hunk[]>) | undefined;
  readonly steering?: Steering | undefined;
  readonly provenance?: boolean | undefined;
  readonly target?: string | undefined;
  readonly baseBlob?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly keep?: string | undefined;
}

export interface GenerateOutcome {
  readonly md: string;
  readonly language: string | undefined;
  readonly hunkCount: number;
  readonly warnings: readonly string[];
  readonly warningsAt: readonly HunkWarning[];
  readonly links?: readonly HunkLink[];
  readonly reproducesNew?: boolean;
}

export async function generatePatch(request: GenerateRequest): Promise<GenerateOutcome> {
  const adapter = pickAdapter({ language: request.language, path: request.path });
  const label = request.label ?? adapter.name;
  checkHeading(label, adapter);
  if (unchanged(request, (line) => adapter.normalize(line))) {
    throw new NoChanges(
      request.exact === true
        ? 'the new version is the base, byte for byte — no patch to write'
        : 'the new version is the base once normalized (spacing, blank lines) — no patch to write',
    );
  }
  await adapter.init();
  request.signal?.throwIfAborted();

  const bridgeGap = request.bridgeGap ?? 0;
  const trace = withProgress(request);
  const maps: MapCache = new Map();

  const header = patchHeader({ adapter, target: request.target, baseBlob: request.baseBlob });
  const print = (all: readonly Hunk[]): string => header + printPatch(all, label, request.keep);

  let hunks: readonly Hunk[];
  const warnings: string[] = [];
  try {
    hunks = await synthesized(request, { adapter, label, bridgeGap, trace, maps }, warnings);
  } catch (e) {
    throw e instanceof SynthesisError && e.draft !== undefined ? printedDraft(e, e.draft, print) : e;
  }

  const md = print(hunks);
  warnings.push(...trailingSpaceWarnings(hunks));
  const warningsAt = trailingSpaceWarningsAt(hunks, md);

  if (request.provenance !== true) return { md, language: label, hunkCount: hunks.length, warnings, warningsAt };
  request.signal?.throwIfAborted();

  const resolved = resolveHunks(request.oldText, parseSirFile(md), adapter, maps);
  return {
    md,
    language: label,
    hunkCount: hunks.length,
    warnings,
    warningsAt,
    links: resolved.links,
    reproducesNew: resolved.applied === request.newText,
  };
}

async function synthesized(
  request: GenerateRequest,
  setting: { adapter: LanguageAdapter; label: string; bridgeGap: number; trace: Tracer | undefined; maps: MapCache },
  warnings: string[],
): Promise<readonly Hunk[]> {
  const { adapter, label, bridgeGap, trace, maps } = setting;
  const steering = request.steering ?? (request.keep !== undefined ? unattended : undefined);
  if (steering !== undefined) {
    const steered = await steerSynthesis(
      {
        oldText: request.oldText,
        newText: request.newText,
        adapter,
        label,
        bridgeGap,
        exact: request.exact ?? false,
        limits: request.limits,
        trace,
        maps,
        keep: request.keep,
        signal: request.signal,
      },
      steering,
    );
    if (!steered.reproducesNew) {
      warnings.push('the patch does not give the new version: changes were left out, or hunks edited by hand make it differ');
    }
    return steered.hunks;
  }
  const made = await synthesizeAsync(request.oldText, request.newText, adapter, {
    bridgeGap,
    ...(request.exact !== undefined ? { exact: request.exact } : {}),
    trace,
    limits: request.limits,
    maps,
    signal: request.signal,
  });
  return request.review !== undefined ? request.review(made) : made;
}

function printPatch(hunks: readonly Hunk[], label: string, keep: string | undefined): string {
  if (keep === undefined) return printSirFile(hunks, label);
  const kept = parseSirFile(keep).hunks.length;
  const own = hunksOf(keep).replace(/\s+$/, '');
  return kept < hunks.length ? `${own}\n\n${printSirFile(hunks.slice(kept), label)}` : `${own}\n`;
}

function printedDraft(e: SynthesisError, draft: SynthesisDraft, print: (hunks: readonly Hunk[]) => string): SynthesisError {
  const text = print(draft.hunks);
  const line = parseSirFile(text).hunks[draft.hunks.length - 1]!.mdSpan![0];
  return new SynthesisError(e.message, e.reason, e.because, e.newLine, { ...draft, printed: { text, line } });
}

function unchanged(request: GenerateRequest, normalize: (raw: string) => string): boolean {
  if (request.oldText === request.newText) return true;
  if (request.exact === true) return false;
  const significant = (text: string): string[] =>
    text.split(/\r?\n/).map(normalize).filter((line) => line !== '');
  const a = significant(request.oldText);
  const b = significant(request.newText);
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

export function patchHeader(fields: {
  readonly adapter?: LanguageAdapter | undefined;
  readonly target?: string | undefined;
  readonly baseBlob?: string | undefined;
}): string {
  return printHeader({
    target: fields.target,
    baseBlob: fields.baseBlob,
    sirVersion: packageIdentity().version,
    grammar: fields.adapter?.grammar !== undefined ? grammarName(fields.adapter.grammar) : undefined,
  });
}

function grammarName(grammar: GrammarSource): string {
  return grammar.package !== undefined && grammar.version !== undefined
    ? `${grammar.package}@${grammar.version}`
    : grammar.file;
}

function withProgress(request: GenerateRequest): Tracer | undefined {
  const { trace, onProgress } = request;
  if (onProgress === undefined) return trace;
  return (event) => {
    trace?.(event);
    if (event.kind === 'segment') onProgress(event.index + 1, event.total);
  };
}
