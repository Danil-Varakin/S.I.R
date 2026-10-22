// The wire, spelled out. Every type a client sees is written here, field by field — none
// is borrowed from the core, so a change inside the core cannot change the protocol
// unnoticed (VERSIONING.md R2): test/unit/protocol-types.test.ts holds each one equal to
// the core type it is filled from, and a difference fails the typecheck until the
// protocol is changed here on purpose — with its number and its row in VERSIONING.md.

// A RANGE, announced in `version`: this sir speaks PROTOCOL_VERSION and still serves,
// unchanged, every client written for PROTOCOL_MIN or later. Every change to the wire
// raises PROTOCOL_VERSION (once per release); only a change an older client would trip
// over raises PROTOCOL_MIN with it. Rules: VERSIONING.md.
export const PROTOCOL_VERSION = 5;
export const PROTOCOL_MIN = 5;

export interface RequestMessage {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface ServiceError {
  readonly kind: string;
  readonly message: string;
  readonly exitCode: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** `elapsedMs`: how long the request took, from its arrival to the reply — for a
 *  client's log and its "slow" hint. Protocol 4. */
export type ResponseMessage =
  | { readonly id: number; readonly ok: true; readonly result: unknown; readonly elapsedMs: number }
  | { readonly id: number; readonly ok: false; readonly error: ServiceError; readonly elapsedMs: number };

export interface ProgressMessage {
  readonly method: 'progress';
  readonly params: { readonly id: number; readonly done: number; readonly total: number };
}

// ── shared shapes ──────────────────────────────────────────────────────────────

/** `{ start, end }` — offsets in UTF-16 units, `end` exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export type LinkStatus = 'ok' | 'no-match' | 'ambiguous' | 'error';

/** Why a hunk did not land: the facts of the core's error. */
export interface LinkFailure {
  readonly kind: string;
  readonly message: string;
  readonly mdLine?: number;
  readonly failedStepIndex?: number;
  readonly totalSteps?: number;
  readonly origPos?: number;
  readonly anchorText?: string;
  readonly candidates?: readonly number[];
}

/** One hunk of a patch, where it lands: in the base and in the patched text. */
export interface HunkLink {
  readonly index: number;
  readonly status: LinkStatus;
  /** lines of the `.sirp` from `# match` to its `# end`, counted from 1 */
  readonly mdSpan?: readonly [number, number];
  /** the hunk's `# note` text, when it has one. Protocol 4. */
  readonly note?: string;
  /** lines of the `.sirp` from `# note` to its `# end`. Protocol 4. */
  readonly noteSpan?: readonly [number, number];
  readonly base?: Span;
  readonly final?: Span;
  readonly finalText?: string;
  readonly dependsOnEarlier: boolean;
  readonly failure?: LinkFailure;
}

/** The core's answer for a whole patch: its hunks, and the text with all of them laid. */
export interface ResolveResult {
  readonly links: readonly HunkLink[];
  readonly applied: string;
}

/** How much context a synthesized hunk may carry. */
export interface SynthLimits {
  readonly minParents: number;
  readonly maxParents: number | 'all';
  readonly parentDetailBase: number;
  readonly minSiblings: number;
  readonly maxSiblings: number;
  readonly siblingDetailBase: number;
  readonly parentsRequired: boolean;
}

export type PartialLimits = { [K in keyof SynthLimits]?: SynthLimits[K] | undefined };

export type GitEol = 'repository' | 'worktree';

/** The settings `generate` applies — the config's, with the request's over them. */
export interface GenerateSettings extends SynthLimits {
  readonly upstream: string | null;
  readonly out: string | null;
  readonly language: string | null;
  readonly exact: boolean;
  readonly bridgeGap: number;
  readonly baseHead: boolean;
  readonly baseBranch: string | null;
  readonly baseCommit: string | null;
  readonly baseEol: GitEol;
}

/** A warning about one hunk, at the line of the patch it is about. Protocol 4. */
export interface HunkWarning {
  /** the hunk, counted from 1 */
  readonly hunk: number;
  /** the line of the `.sirp`, counted from 1 */
  readonly mdLine: number;
  readonly message: string;
}

/** Why `pair` names no file. A client may switch on it. */
export type PairReason =
  | 'no-out'
  | 'outside-upstream'
  | 'flat-out'
  | 'outside-out'
  | 'not-a-patch-name'
  | 'unsafe-target'
  | 'two-patches'
  | 'newer-format'
  | 'older-format'
  | 'bad-header';

// ── params ───────────────────────────────────────────────────────────────────────

export interface LanguageParams {
  readonly language?: string;
  readonly path?: string;
  /** accepted and ignored since protocol 4: grammars ship inside sir, nothing is
   *  downloaded */
  readonly allowDownload?: boolean;
}

/** The OLD version NAMED instead of sent: the same three coordinates the CLI takes,
 *  each one optional, what is missing taking its default — the branch we are on, its
 *  last commit, the path of `params.path` inside the repository. All three left out
 *  (`baseGit: {}`) is "this same file, as of the last commit here".
 *
 *  Needs `params.path`: the repository is found from it, and it supplies the default
 *  path inside that repository. */
export interface GitSourceParams {
  readonly branch?: string;
  readonly commit?: string;
  readonly repoPath?: string;
  /** Not a coordinate: the line endings of what is read — `repository` (the default),
   *  as git stores it; `worktree`, those of the file at `params.path` on disk. Protocol 4. */
  readonly eol?: GitEol;
}

/** The version a method works from — the OLD one for `generate`, the one to patch for
 *  `resolve`/`apply`. Sent as text or named in git: exactly one of the two. */
export interface BaseParams {
  readonly baseText?: string;
  readonly baseGit?: GitSourceParams;
}

/** What a request may set over the project's config — `generate`'s own params, and
 *  `config`/`pair`'s `overrides`: the same names, read by the same code. */
export interface SettingsParams {
  readonly language?: string;
  readonly exact?: boolean;
  readonly bridgeGap?: number;
  readonly limits?: PartialLimits;
  readonly out?: string;
  /** absolute: the config to use, no search — for a project beside its upstream.
   *  Protocol 4. */
  readonly configPath?: string;
}

export interface GenerateParams extends LanguageParams, BaseParams, SettingsParams {
  readonly newText: string;
  /** A `.sirp` whose hunks are settled — typically `SynthesisError`'s `detail.draft`,
   *  finished by hand. Every hunk must land on the base in order; synthesis goes on from
   *  them, and they open `patch` byte for byte. Protocol 5. */
  readonly keep?: string;
}

/** `detail` of a `SynthesisError` (`no-match`, `ambiguous`). `draft` and the fields after
 *  it only when there is a change to write by hand — protocol 5. */
export interface SynthesisErrorDetail {
  readonly reason: 'no-match' | 'ambiguous' | 'unreproduced';
  /** the line of `newText` the change starts on, from 1. Protocol 4. */
  readonly newLine?: number;
  /** the `.sirp` to finish by hand and send back as `keep`: the header `generate` writes,
   *  the hunks so far, and last a hunk to start the change from. No prose */
  readonly draft?: string;
  /** that last hunk, counted from 1 */
  readonly draftHunk?: number;
  /** the line of its `# match` in `draft`, from 1 */
  readonly draftLine?: number;
  /** the change: its line in the text the hunks so far make of the base (from 1), the
   *  lines it takes out and those it puts in */
  readonly change?: { readonly line: number; readonly removed: readonly string[]; readonly added: readonly string[] };
}

/** `config`/`pair`: the settings a `generate` with these params would use. The base as
 *  `generate` takes it, without the text: `baseGit`, or `base: "text"` for "the client
 *  sends `baseText`". Protocol 4. */
export interface OverridesParams extends SettingsParams {
  readonly baseGit?: GitSourceParams;
  readonly base?: 'text';
}

export interface ConfigParams {
  /** absolute — a file of code, or a .sirp (then the base is that of the file it patches) */
  readonly path: string;
  /** absolute: the config to use, no search (as in `overrides`). Protocol 4. */
  readonly configPath?: string;
  readonly overrides?: OverridesParams;
}

export interface PairParams {
  /** absolute — a file of code, or a .sirp */
  readonly path: string;
  /** the patch's text, when the client has it unsaved; else it is read from `path` */
  readonly patch?: string;
  /** absolute: the config to use, no search (as in `overrides`). Protocol 4. */
  readonly configPath?: string;
  readonly overrides?: OverridesParams;
}

export interface ResolveParams extends LanguageParams, BaseParams {
  /** the text of the `.sirp`; with a `path` that is a `.sirp` it may be left out and
   *  is read from that file */
  readonly patch?: string;
  /** as for `generate`: the config whose `generate.base` is taken when none is sent */
  readonly configPath?: string;
}

export type ApplyParams = ResolveParams;

/** Takes back a request still running. Protocol 4. */
export interface CancelParams {
  /** the `id` of that request */
  readonly id: number;
}

/** The text of a new sir.config.json. The service writes nothing: the client asks
 *  the user, writes the file and decides about overwriting. Protocol 4. */
export interface ConfigTemplateParams {
  /** absolute; the repository root is found from it */
  readonly path: string;
  /** the config schema to write, within `version().configSchemaMin..configSchema`;
   *  the newest when left out */
  readonly version?: number;
  /** initial values, in the paths of the config: `{ generate: { out: "patches/" } }` or
   *  `{ "generate.out": "patches/" }` */
  readonly settings?: Readonly<Record<string, unknown>>;
}

// ── results ──────────────────────────────────────────────────────────────────────

export interface CancelResult {
  /** `true`: the request was running and is told to stop. `generate` then answers
   *  `Cancelled` at its next change — or as usual, if it had none left; the other methods
   *  answer as usual. `false`: no request with that id is running. */
  readonly cancelled: boolean;
}

export interface VersionResult {
  readonly sir: string;
  /** the newest protocol this sir speaks */
  readonly protocol: number;
  /** the oldest client protocol still served unchanged. Absent before protocol 3 — a
   *  client reads a missing one as equal to `protocol`. */
  readonly protocolMin?: number;
  /** the newest config schema this sir reads and writes */
  readonly configSchema: number;
  /** the oldest config schema still read. Absent before protocol 3, read as `configSchema`. */
  readonly configSchemaMin?: number;
  readonly languages: readonly string[];
}

export interface AppliedConfig {
  readonly file: string | null;
  readonly settings: GenerateSettings;
  readonly origins: Readonly<Record<string, string>>;
}

export interface GenerateResult {
  /** the `.sirp`, header first (`Sir`, `Target` with a `path`, `Base-Blob` for a git base, `Sir-Version`, `Grammar`) */
  readonly patch: string;
  /** `<revision>:<path>` when the base came out of git, null when it was sent as text. */
  readonly baseSpec: string | null;
  readonly language: string | undefined;
  readonly warnings: readonly string[];
  /** the warnings about one hunk, with the patch line each is about. Protocol 4. */
  readonly warningsAt: readonly HunkWarning[];
  readonly hunks: readonly HunkLink[];
  readonly reproducesNew: boolean;
  readonly outPath: string | null;
  /** a file is at `outPath` already. Protocol 4. */
  readonly outExists: boolean;
  /** the `Target` that file names (null for none): when it is not this patch's, the
   *  client asks before writing over another file's patch. Protocol 4. */
  readonly outTarget: string | null;
  readonly config: AppliedConfig;
}

/** The header of the patch as read: the format and the fields sir knows. Protocol 4. */
export interface PatchHeader {
  readonly format: number;
  readonly target?: string | undefined;
  /** the field `Base-Blob`. Protocol 5. */
  readonly baseBlob?: string | undefined;
  /** the field `Sir-Version`, the bare version. Protocol 5. */
  readonly sirVersion?: string | undefined;
  readonly grammar?: string | undefined;
}

/** What `resolve` and `apply` answer about the patch itself, beside the hunks. Protocol 4. */
interface PatchFacts {
  readonly header: PatchHeader;
  /** the file the patch was laid on, absolute — `path`, or the file `Target` names when
   *  `path` is the patch */
  readonly code: string | null;
  /** as in `generate`: the warnings about a hunk, each at its patch line */
  readonly warningsAt: readonly HunkWarning[];
}

export interface ResolveResultMessage extends PatchFacts {
  readonly hunks: readonly HunkLink[];
  /** `<revision>:<path>` when the base came out of git, null when it was sent as text. */
  readonly baseSpec: string | null;
  /** The base out of git, the text `hunks` offsets count in; absent when the base was
   *  sent as text. Protocol 4. */
  readonly baseText?: string;
}

export interface ApplyResultMessage extends PatchFacts {
  readonly text: string;
  readonly hunks: readonly HunkLink[];
  readonly baseSpec: string | null;
}

export interface ConfigTemplateResult {
  readonly text: string;
  /** the schema version written */
  readonly version: number;
  /** where the core itself looks for the config from `path`: the repository root, or
   *  the directory of `path` outside a repository */
  readonly suggestedPath: string;
  /** whether a file is already there */
  readonly exists: boolean;
  /** every schema this sir reads, oldest first, each with one line of what it holds */
  readonly versions: readonly { readonly version: number; readonly summary: string }[];
}

/** Where `generate` would take its base from. Protocol 4. */
export type BaseInfo =
  | { readonly kind: 'text' }
  | {
      readonly kind: 'git';
      /** as `baseSpec`: `<revision>:<path>` */
      readonly spec: string;
      /** the full hash of the commit the revision names now */
      readonly sha: string;
      readonly eol: GitEol;
    }
  | {
      /** the base the settings name in git cannot be read now — the file is not in that
       *  revision yet, the branch does not exist: `generate` would fail with `error` */
      readonly kind: 'unavailable';
      readonly error: ServiceError;
    };

export interface ConfigResult extends AppliedConfig {
  /** the schema version the config file names; null without a file */
  readonly schemaVersion: number | null;
  /** the repository root around `path` by the core's rules, or null */
  readonly repoRoot: string | null;
  /** the directory of the config file, or null without one. Protocol 4. */
  readonly projectRoot: string | null;
  /** the root of the code the project patches (`upstream`, absolute), or null. Protocol 4. */
  readonly upstreamRoot: string | null;
  /** the `Target` of the pair: what the patch of this file names, or what this patch
   *  names; null when there is none. Protocol 4. */
  readonly target: string | null;
  /** the language `generate` names in `# match` for this file — its own name (`cpp` for
   *  `.cc`), after `generate.language`; for a `.sirp`, that of the file `pair` names for
   *  it. null when none is picked: an unknown extension, no pair. Protocol 5. */
  readonly language: string | null;
  /** the header `generate` would write for this file now, with the same `overrides`,
   *  its blank line after it: `Sir`, then `Target`, `Base-Blob` (a git base that could
   *  be read), `Sir-Version`, `Grammar` (a language picked) — each left out when it has
   *  no value. For a `.sirp`, that of the file `pair` names for it; null with no pair.
   *  Protocol 5. */
  readonly header: string | null;
  /** null: `generate` would refuse for want of a base — none sent, none in the config;
   *  `unavailable`: a git base is named but cannot be read (protocol 4) */
  readonly base: BaseInfo | null;
  /** absolute paths whose change may change this answer; nothing is watched here */
  readonly watch: readonly string[];
}

export type PairResult =
  | {
      /** `path` is code */
      readonly kind: 'code';
      /** where `generate` puts its .sirp — `outPath` — or null, with `reason` */
      readonly patchPath: string | null;
      readonly exists: boolean;
      readonly how: 'upstream' | 'beside' | 'out' | null;
      readonly reason?: PairReason;
      /** `two-patches`: both patches of the one file */
      readonly patchPaths?: readonly string[];
    }
  | {
      /** `path` is a .sirp */
      readonly kind: 'patch';
      /** the file it patches, absolute, or null, with `reason` */
      readonly code: string | null;
      readonly exists: boolean;
      readonly how: 'target' | 'upstream' | 'beside' | 'out' | null;
      readonly reason?: PairReason;
    };
