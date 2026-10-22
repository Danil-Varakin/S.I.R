import type { Hunk } from '../core/ast.ts';
import type { HunkLink } from '../core/resolve.ts';
import type { MapCache } from '../lang/source-map.ts';
import type { PartialLimits, Tracer } from './synth.ts';
import { parseHatchFile } from '../core/hatch-parser.ts';
import { resolveHunks } from '../core/resolve.ts';
import { checkHeading, pickAdapter } from '../lang/adapter.ts';
import { printHatchFile, trailingSpaceWarnings, trailingSpaceWarningsAt } from './printer.ts';
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
  /** After synthesis, the hunks to keep. Kept for API callers; `steering` is the way a
   *  person takes part now — asked hunk by hunk, with an editor. */
  readonly review?: ((hunks: readonly Hunk[]) => Promise<Hunk[]>) | undefined;
  /** Synthesis a person steers (`generate/steer.ts`): asked about each hunk as it is
   *  made, and handed the editor when a change cannot be anchored. */
  readonly steering?: Steering | undefined;
  readonly provenance?: boolean | undefined;
  /** The header's `Target` (`core/header.ts`): the path of the file, already measured
   *  from the root a reader measures it from; no `Target` without it. */
  readonly target?: string | undefined;
  /** The header's `Base-Blob`: the id of the git blob the base was read from; none for
   *  a base that did not come out of git. */
  readonly baseBlob?: string | undefined;
  /** Stops the run between two changes, throwing the signal's reason. A person steering
   *  stops it at the terminal instead. */
  readonly signal?: AbortSignal | undefined;
  /** A `.hatch` whose hunks are settled — a draft a person finished (`SynthesisError`'s
   *  `draft`): checked, then synthesis goes on from them, with no one to steer. Its hunks
   *  open the patch byte for byte, as written. */
  readonly keep?: string | undefined;
}

export interface GenerateOutcome {
  readonly md: string;
  readonly language: string | undefined;
  readonly hunkCount: number;
  readonly warnings: readonly string[];
  /** the warnings about one hunk, each with the line of `md` it is about */
  readonly warningsAt: readonly HunkWarning[];
  readonly links?: readonly HunkLink[];
  readonly reproducesNew?: boolean;
}

export async function generatePatch(request: GenerateRequest): Promise<GenerateOutcome> {
  const adapter = pickAdapter({ language: request.language, path: request.path });
  // The heading names the language by its own name (`cpp`, `objc`, `python`), however it
  // was picked — `--language c++`, a `.mm` file, a config: the same patch from the CLI and
  // from the service. `label` overrides it for an API caller, and is held to the check.
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
  // a `keep` that stands opens the patch as it was written; one that does not is thrown first
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

  const resolved = resolveHunks(request.oldText, parseHatchFile(md), adapter, maps);
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

/** The hunks: synthesis on its own, or steered — by a person, or by no one from `keep`.
 *  A steered run that does not give the new version says so in `warnings`. */
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

/** The hunks as a `.hatch` body. With `keep` — it stood, so its hunks are the first ones
 *  — they are its own text, from the first heading on, byte for byte; the hunks made
 *  after them are printed below. */
function printPatch(hunks: readonly Hunk[], label: string, keep: string | undefined): string {
  if (keep === undefined) return printHatchFile(hunks, label);
  const kept = parseHatchFile(keep).hunks.length;
  const own = hunksOf(keep).replace(/\s+$/, '');
  return kept < hunks.length ? `${own}\n\n${printHatchFile(hunks.slice(kept), label)}` : `${own}\n`;
}

/** The draft printed as `generate` would print the patch, and where its last hunk is. */
function printedDraft(e: SynthesisError, draft: SynthesisDraft, print: (hunks: readonly Hunk[]) => string): SynthesisError {
  const text = print(draft.hunks);
  const line = parseHatchFile(text).hunks[draft.hunks.length - 1]!.mdSpan![0];
  return new SynthesisError(e.message, e.reason, e.because, e.newLine, { ...draft, printed: { text, line } });
}

/** The first question, before a grammar is loaded or a hunk is looked for. Without
 *  `exact` a change is one synthesis would have to write: each line as the language
 *  normalizes it, blank lines not counted — spacing and empty lines alone are no change.
 *  With `exact`, byte for byte. */
function unchanged(request: GenerateRequest, normalize: (raw: string) => string): boolean {
  if (request.oldText === request.newText) return true;
  if (request.exact === true) return false;
  const significant = (text: string): string[] =>
    text.split(/\r?\n/).map(normalize).filter((line) => line !== '');
  const a = significant(request.oldText);
  const b = significant(request.newText);
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** The header `generate` writes, its blank line after it — the one code for `generate`
 *  and for `config`, which answers it without a patch. No `Grammar` without an adapter,
 *  no `Target` or `Base-Blob` without their values. The grammar is not loaded. */
export function patchHeader(fields: {
  readonly adapter?: LanguageAdapter | undefined;
  readonly target?: string | undefined;
  readonly baseBlob?: string | undefined;
}): string {
  return printHeader({
    target: fields.target,
    baseBlob: fields.baseBlob,
    hatchVersion: packageIdentity().version,
    grammar: fields.adapter?.grammar !== undefined ? grammarName(fields.adapter.grammar) : undefined,
  });
}

/** `<package>@<version>` as the adapter pins it; the file name for a grammar with no
 *  package behind it. */
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
