import type { Hunk } from './ast.ts';

export function firstLineOf(e: unknown): string {
  return String(e instanceof Error ? e.message : e).trim().split('\n')[0] ?? '';
}

export abstract class SirError extends Error {
  abstract readonly exitCode: number;
  hunkAt: { readonly hunk: number; readonly mdLine?: number } | undefined;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** The facts of this error as plain data — what the service sends as `detail`, part
   *  of the protocol. A new error kind states its own here, and nothing else changes. */
  detail(): Record<string, unknown> | undefined {
    return undefined;
  }
}

export class ParseError extends SirError {
  readonly exitCode = 2;
  readonly mdLine: number;
  readonly hint?: string;

  constructor(message: string, mdLine: number, hint?: string) {
    super(
      `line ${mdLine}: ${message}` +
        (hint !== undefined ? `\n  hint: ${hint}` : ''),
    );
    this.mdLine = mdLine;
    if (hint !== undefined) this.hint = hint;
  }

  override detail(): Record<string, unknown> {
    return { mdLine: this.mdLine, ...(this.hint !== undefined ? { hint: this.hint } : {}) };
  }
}

export class MatchError extends SirError {
  readonly exitCode = 3;
  readonly deepestPos: number;
  readonly failedStepIndex: number;
  readonly totalSteps: number | undefined;
  readonly origPos: number | undefined;
  readonly anchorText: string | undefined;
  readonly matchedText: string | undefined;
  readonly matchedPos: number | undefined;
  readonly hint: string | undefined;

  constructor(
    message: string,
    deepestPos: number,
    failedStepIndex: number,
    detail: {
      readonly totalSteps?: number;
      readonly origPos?: number;
      readonly anchorText?: string;
      readonly matchedText?: string;
      readonly matchedPos?: number;
      readonly hint?: string;
    } = {},
  ) {
    super(message);
    this.deepestPos = deepestPos;
    this.failedStepIndex = failedStepIndex;
    this.totalSteps = detail.totalSteps;
    this.origPos = detail.origPos;
    this.anchorText = detail.anchorText;
    this.matchedText = detail.matchedText;
    this.matchedPos = detail.matchedPos;
    this.hint = detail.hint;
  }

  override detail(): Record<string, unknown> {
    return {
      failedStepIndex: this.failedStepIndex,
      ...(this.totalSteps !== undefined ? { totalSteps: this.totalSteps } : {}),
      ...(this.origPos !== undefined ? { origPos: this.origPos } : {}),
      ...(this.anchorText !== undefined ? { anchorText: this.anchorText } : {}),
    };
  }
}

export class PathError extends SirError {
  readonly exitCode = 1;
  readonly path: string;
  readonly blocker: string;

  constructor(message: string, path: string, blocker: string) {
    super(message);
    this.path = path;
    this.blocker = blocker;
  }

  override detail(): Record<string, unknown> {
    return { path: this.path, blocker: this.blocker };
  }
}

export class ConfigError extends SirError {
  readonly exitCode = 5;
  readonly file: string | undefined;
  readonly facts: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, file?: string, facts?: Record<string, unknown>) {
    super(file !== undefined ? `${file}: ${message}` : message);
    this.file = file;
    this.facts = facts;
  }

  override detail(): Record<string, unknown> | undefined {
    if (this.file === undefined && this.facts === undefined) return undefined;
    return { ...(this.file !== undefined ? { file: this.file } : {}), ...this.facts };
  }
}

export class GrammarError extends SirError {
  readonly exitCode = 6;
  readonly grammar: string | undefined;

  constructor(message: string, grammar?: string) {
    super(grammar !== undefined ? `${grammar}: ${message}` : message);
    this.grammar = grammar;
  }

  override detail(): Record<string, unknown> | undefined {
    return this.grammar !== undefined ? { grammar: this.grammar } : undefined;
  }
}

export class LanguageError extends SirError {
  readonly exitCode = 1;
  readonly language: string | undefined;
  readonly extension: string | undefined;

  constructor(message: string, detail: { language?: string; extension?: string } = {}) {
    super(message);
    this.language = detail.language;
    this.extension = detail.extension;
  }

  override detail(): Record<string, unknown> {
    return {
      ...(this.language !== undefined ? { language: this.language } : {}),
      ...(this.extension !== undefined ? { extension: this.extension } : {}),
    };
  }
}

/** Why git gave no version — part of the protocol (`detail.reason`): a client may
 *  switch on it, e.g. offer a fetch for `no-such-branch`. */
export type GitErrorReason =
  | 'no-such-file'
  | 'not-a-file'
  | 'no-such-branch'
  | 'not-a-branch'
  | 'no-such-commit'
  | 'not-on-branch'
  | 'no-commits'
  | 'no-repository'
  | 'outside-repository'
  | 'bad-coordinate'
  | 'no-git';

export class GitError extends SirError {
  readonly exitCode = 1;
  readonly revision: string | undefined;
  readonly reason: GitErrorReason;
  readonly flag: string | undefined;

  constructor(message: string, reason: GitErrorReason, options: { revision?: string | undefined; flag?: string | undefined } = {}) {
    super(message);
    this.reason = reason;
    this.revision = options.revision;
    this.flag = options.flag;
  }

  override detail(): Record<string, unknown> | undefined {
    return { reason: this.reason, ...(this.revision !== undefined ? { revision: this.revision } : {}) };
  }
}

export class NoChanges extends SirError {
  readonly exitCode = 7;
  readonly baseSpec: string | null;

  constructor(message: string, baseSpec: string | null = null) {
    super(message);
    this.baseSpec = baseSpec;
  }

  override detail(): Record<string, unknown> {
    return { baseSpec: this.baseSpec };
  }
}

export type SynthesisFailure = 'no-match' | 'ambiguous' | 'unreproduced';

export interface SynthesisDraft {
  readonly hunks: readonly Hunk[];
  readonly change: { readonly line: number; readonly removed: readonly string[]; readonly added: readonly string[] };
  readonly printed?: { readonly text: string; readonly line: number };
}

export class SynthesisError extends SirError {
  readonly exitCode = 8;
  readonly reason: SynthesisFailure;
  readonly newLine: number | undefined;
  readonly because: string;
  readonly draft: SynthesisDraft | undefined;

  constructor(message: string, reason: SynthesisFailure, because: string, newLine?: number, draft?: SynthesisDraft) {
    super(message);
    this.reason = reason;
    this.because = because;
    this.newLine = newLine;
    this.draft = draft;
  }

  override detail(): Record<string, unknown> {
    const printed = this.draft?.printed;
    return {
      reason: this.reason,
      ...(this.newLine !== undefined ? { newLine: this.newLine } : {}),
      ...(printed !== undefined
        ? { draft: printed.text, draftHunk: this.draft!.hunks.length, draftLine: printed.line, change: this.draft!.change }
        : {}),
    };
  }
}

export class AmbiguityError extends SirError {
  readonly exitCode = 4;
  readonly positions: number[];
  readonly spanEnds: (number | undefined)[];

  constructor(message: string, positions: number[], spanEnds: (number | undefined)[] = []) {
    super(message);
    this.positions = positions;
    this.spanEnds = spanEnds;
  }

  override detail(): Record<string, unknown> {
    return { positions: this.positions };
  }
}
