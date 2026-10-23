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

export type ResponseMessage =
  | { readonly id: number; readonly ok: true; readonly result: unknown; readonly elapsedMs: number }
  | { readonly id: number; readonly ok: false; readonly error: ServiceError; readonly elapsedMs: number };

export interface ProgressMessage {
  readonly method: 'progress';
  readonly params: { readonly id: number; readonly done: number; readonly total: number };
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

export type LinkStatus = 'ok' | 'no-match' | 'ambiguous' | 'error';

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

export interface HunkLink {
  readonly index: number;
  readonly status: LinkStatus;
  readonly mdSpan?: readonly [number, number];
  readonly note?: string;
  readonly noteSpan?: readonly [number, number];
  readonly base?: Span;
  readonly final?: Span;
  readonly finalText?: string;
  readonly dependsOnEarlier: boolean;
  readonly failure?: LinkFailure;
}

export interface ResolveResult {
  readonly links: readonly HunkLink[];
  readonly applied: string;
}

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

export interface HunkWarning {
  readonly hunk: number;
  readonly mdLine: number;
  readonly message: string;
}

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

export interface LanguageParams {
  readonly language?: string;
  readonly path?: string;
  readonly allowDownload?: boolean;
}

export interface GitSourceParams {
  readonly branch?: string;
  readonly commit?: string;
  readonly repoPath?: string;
  readonly eol?: GitEol;
}

export interface BaseParams {
  readonly baseText?: string;
  readonly baseGit?: GitSourceParams;
}

export interface SettingsParams {
  readonly language?: string;
  readonly exact?: boolean;
  readonly bridgeGap?: number;
  readonly limits?: PartialLimits;
  readonly out?: string;
  readonly configPath?: string;
}

export interface GenerateParams extends LanguageParams, BaseParams, SettingsParams {
  readonly newText: string;
  readonly keep?: string;
}

export interface SynthesisErrorDetail {
  readonly reason: 'no-match' | 'ambiguous' | 'unreproduced';
  readonly newLine?: number;
  readonly draft?: string;
  readonly draftHunk?: number;
  readonly draftLine?: number;
  readonly change?: { readonly line: number; readonly removed: readonly string[]; readonly added: readonly string[] };
}

export interface OverridesParams extends SettingsParams {
  readonly baseGit?: GitSourceParams;
  readonly base?: 'text';
}

export interface ConfigParams {
  readonly path: string;
  readonly configPath?: string;
  readonly overrides?: OverridesParams;
}

export interface PairParams {
  readonly path: string;
  readonly patch?: string;
  readonly configPath?: string;
  readonly overrides?: OverridesParams;
}

export interface ResolveParams extends LanguageParams, BaseParams {
  readonly patch?: string;
  readonly configPath?: string;
}

export type ApplyParams = ResolveParams;

export interface CancelParams {
  readonly id: number;
}

export interface ConfigTemplateParams {
  readonly path: string;
  readonly version?: number;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface CancelResult {
  readonly cancelled: boolean;
}

export interface VersionResult {
  readonly sir: string;
  readonly protocol: number;
  readonly protocolMin?: number;
  readonly configSchema: number;
  readonly configSchemaMin?: number;
  readonly languages: readonly string[];
}

export interface AppliedConfig {
  readonly file: string | null;
  readonly settings: GenerateSettings;
  readonly origins: Readonly<Record<string, string>>;
}

export interface GenerateResult {
  readonly patch: string;
  readonly baseSpec: string | null;
  readonly language: string | undefined;
  readonly warnings: readonly string[];
  readonly warningsAt: readonly HunkWarning[];
  readonly hunks: readonly HunkLink[];
  readonly reproducesNew: boolean;
  readonly outPath: string | null;
  readonly outExists: boolean;
  readonly outTarget: string | null;
  readonly config: AppliedConfig;
}

export interface PatchHeader {
  readonly format: number;
  readonly target?: string | undefined;
  readonly baseBlob?: string | undefined;
  readonly sirVersion?: string | undefined;
  readonly grammar?: string | undefined;
}

interface PatchFacts {
  readonly header: PatchHeader;
  readonly code: string | null;
  readonly warningsAt: readonly HunkWarning[];
}

export interface ResolveResultMessage extends PatchFacts {
  readonly hunks: readonly HunkLink[];
  readonly baseSpec: string | null;
  readonly baseText?: string;
}

export interface ApplyResultMessage extends PatchFacts {
  readonly text: string;
  readonly hunks: readonly HunkLink[];
  readonly baseSpec: string | null;
}

export interface ConfigTemplateResult {
  readonly text: string;
  readonly version: number;
  readonly suggestedPath: string;
  readonly exists: boolean;
  readonly versions: readonly { readonly version: number; readonly summary: string }[];
}

export type BaseInfo =
  | { readonly kind: 'text' }
  | {
      readonly kind: 'git';
      readonly spec: string;
      readonly sha: string;
      readonly eol: GitEol;
    }
  | {
      readonly kind: 'unavailable';
      readonly error: ServiceError;
    };

export interface ConfigResult extends AppliedConfig {
  readonly schemaVersion: number | null;
  readonly repoRoot: string | null;
  readonly projectRoot: string | null;
  readonly upstreamRoot: string | null;
  readonly target: string | null;
  readonly language: string | null;
  readonly header: string | null;
  readonly base: BaseInfo | null;
  readonly watch: readonly string[];
}

export type PairResult =
  | {
      readonly kind: 'code';
      readonly patchPath: string | null;
      readonly exists: boolean;
      readonly how: 'upstream' | 'beside' | 'out' | null;
      readonly reason?: PairReason;
      readonly patchPaths?: readonly string[];
    }
  | {
      readonly kind: 'patch';
      readonly code: string | null;
      readonly exists: boolean;
      readonly how: 'target' | 'upstream' | 'beside' | 'out' | null;
      readonly reason?: PairReason;
    };
