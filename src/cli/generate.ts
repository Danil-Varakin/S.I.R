import { resolve } from 'node:path';
import type { Tracer, SynthEvent } from '../generate/synth.ts';
import { generatePatch } from '../generate/pipeline.ts';
import { printPattern } from '../core/hatch-printer.ts';
import { describeHunk } from '../generate/agreement.ts';
import type { GenerateOutcome, GenerateRequest } from '../generate/pipeline.ts';
import type { Steering } from '../generate/steer.ts';
import { ConfigError, SynthesisError } from '../core/errors.ts';
import { editorCommand, editSession } from './editor.ts';
import type { EditSession } from './editor.ts';
import { InputClosed } from '../infra/ask.ts';
import type { Ask } from '../infra/ask.ts';
import { checkParent, ensureParent, readInputFile, writeFileAtomic } from '../infra/fs.ts';
import { resolveOutPath } from '../infra/out-path.ts';
import { CONFIG_FILE_NAME, basesOnGit, formatConfig, gitSourceOf, overridesFrom } from '../infra/config/index.ts';
import type { FlagOverride, PartialSettings, ResolvedConfig } from '../infra/config/index.ts';
import type { ErrorContext, Logger } from '../infra/log.ts';
import type { ArgSpec } from './args.ts';
import { runCommand } from './command.ts';
import { GIT_ARGS, GIT_FLAG_NAMES, GIT_USAGE, asksGit, gitEol } from './git-source.ts';
import { fileFromGit } from '../infra/git.ts';
import { isPatchPath, patchAt, patchTarget } from '../infra/pair.ts';
import { loadProject } from '../infra/project.ts';
import type { Project } from '../infra/project.ts';
import type { FileVersion, GitOptions } from './git-source.ts';
import { CONFIRM_ARGS, CONFIRM_USAGE, atTerminal, terminalAsker } from './confirm.ts';
import type { ConfirmOptions } from './confirm.ts';
import { answersFrom } from './prompt.ts';
import { namedLanguage } from '../lang/adapter.ts';
import type { Answers } from './prompt.ts';

interface Options extends GitOptions, ConfirmOptions {
  in?: string;
  inOld?: string;
  out?: string;
  language?: string;
  config?: string;
  log?: string;
  parents?: unknown;
  minParents?: unknown;
  parentDetailBase?: unknown;
  siblings?: unknown;
  minSiblings?: unknown;
  siblingDetailBase?: unknown;
  bridgeGap?: unknown;
  requireParents: boolean;
  useConfig: boolean;
  printConfig: boolean;
  agreement: boolean;
  exact: boolean;
  debug: boolean;
  help: boolean;
}

const USAGE = `hatch generate — synthesize a .hatch patch from two versions of a file

  --in,     -i <file>     new version of the file                    [required]

The OLD version — exactly one source, either a file on disk or git.

  --in-old     <file>     old version, read from this path

${GIT_USAGE}

A project that always compares against the same version names it once in
${CONFIG_FILE_NAME}: generate.base.head / .branch / .commit, as the flags above. Any
git flag replaces those three as a whole for this run; --in-old ignores them.

${CONFIRM_USAGE}

  --out,    -o <path>     where to write the .hatch. A directory (existing, or ending
                          with a slash, or a name without an extension) gets
                          <name of --in>.hatch inside it; a file must be a .hatch and
                          is written as is, over what is there. Missing directories
                          are created. A relative path is measured from the
                          repository root, not from the current directory. Omitted
                          means next to --in; \`-\` writes to stdout. With
                          "upstream" in ${CONFIG_FILE_NAME} a directory is the root of
                          a tree that repeats the upstream's:
                          <config dir>/<out>/<path of --in from the upstream>.hatch.
                          A patch already at a place hatch computed that names
                          another Target is not written over without asking (--yes)
  --language,-l <lang>    force language (else: extension of --in)
  --agreement,-a          confirm each hunk before writing
  --exact,  -e            reproduce the new file byte for byte; without it every
                          line only has to match after normalization (indentation
                          and inner spacing are free, the set of lines is not)
  --debug,  -v            trace synthesis to stderr: every segment, each probe
                          attempt (incl. non-unique) and the chosen hunk
  --log [place]           also write a full log — the resolved config and the whole
                          synthesis trace, whether or not -v is on. A place that is a
                          directory (or ends in /) receives a generated name, so every
                          run gets its own file; any other place IS the name and is
                          overwritten. Omitted → ./hatch-logs/. A log that cannot be
                          opened is a warning, not a failure: the run goes on without it
  --help,   -h            this help

Anchoring (how much context a generated hunk carries). Every one of these can also
be set in ${CONFIG_FILE_NAME}; the flag wins for this run.

  --parents <n|all>       cap on climbing up: at most n enclosing blocks per
                          pattern (default: all)
  --min-parents <n>       enclosing blocks EVERY pattern carries (default: 1).
                          A hunk with no parent is not structural — drifting
                          neighbours can land it in another function
  --parent-detail <n>     bracket levels spelled out in parent headers, counting
                          from the outermost: 0 gives \`foo( ... )\`, 1 gives
                          \`foo(bar( ... ))\` (default: 0). This is the READABLE
                          baseline; when an anchor turns out ambiguous the ladder
                          unfolds further on its own, one NAMED bracket at a time,
                          and stops as soon as no bracket tells the places apart
  --min-siblings <n>      neighbouring significant lines EVERY pattern carries,
                          per side (default: 0)
  --siblings <n>          cap of neighbouring significant lines per side
                          (default: 8). 0 forbids leaning on neighbours at all —
                          anchoring stays purely structural
  --sibling-detail <n>    same bracket baseline for neighbour anchors (default: 0)
  --require-parents       never fall back to a parentless pattern: fail instead of
                          emitting an anchor that drift can move
  --bridge-gap <n>        stitch edits split by up to n unchanged non-blank lines
                          back into one hunk (default: 0)

Configuration

  --config <file>         use this config file — no search. Without it: the
                          ${CONFIG_FILE_NAME} up from --in to its repository root;
                          else the one whose "upstream" holds --in, in a
                          subdirectory of a repository root on the way up or in a
                          directory above the repository; else $HATCH_CONFIG; else
                          the one in the current directory, if it claims --in.
                          The search never enters the home directory
  --no-config             ignore config files entirely (built-in defaults + flags)
  --print-config          print the effective settings with the origin of each
                          (default / config / flag) and exit`;

/** Exported for the C6 test: every flag here has a config key or is exempt by name. */
export const SPEC: ArgSpec<Options> = {
  flags: {
    ...GIT_ARGS.flags,
    ...CONFIRM_ARGS.flags,
    '--agreement': 'agreement', '-a': 'agreement',
    '--exact': 'exact', '-e': 'exact',
    '--debug': 'debug', '-v': 'debug',
    '--help': 'help', '-h': 'help',
    '--require-parents': 'requireParents',
    '--print-config': 'printConfig',
  },
  negated: { '--no-config': 'useConfig' },
  values: {
    ...GIT_ARGS.values,
    '--in': 'in', '-i': 'in',
    '--in-old': 'inOld',
    '--out': 'out', '-o': 'out',
    '--language': 'language', '-l': 'language',
    '--config': 'config',
  },
  counts: {
    '--parents': 'parents',
    '--min-parents': 'minParents',
    '--parent-detail': 'parentDetailBase',
    '--min-siblings': 'minSiblings',
    '--siblings': 'siblings',
    '--sibling-detail': 'siblingDetailBase',
    '--bridge-gap': 'bridgeGap',
  },
  optional: { '--log': 'log' },
};

const INITIAL: Options = {
  head: false,
  yes: false,
  requireParents: false,
  useConfig: true,
  printConfig: false,
  agreement: false,
  exact: false,
  debug: false,
  help: false,
};

function flagOverrides(opts: Options): FlagOverride[] {
  const values: PartialSettings = {
    out: opts.out,
    baseEol: gitEol(opts.eol),
    language: namedLanguage(opts.language),
    exact: opts.exact ? true : undefined,
    bridgeGap: opts.bridgeGap as PartialSettings['bridgeGap'],
    minParents: opts.minParents as PartialSettings['minParents'],
    maxParents: opts.parents as PartialSettings['maxParents'],
    parentDetailBase: opts.parentDetailBase as PartialSettings['parentDetailBase'],
    parentsRequired: opts.requireParents ? true : undefined,
    minSiblings: opts.minSiblings as PartialSettings['minSiblings'],
    maxSiblings: opts.siblings as PartialSettings['maxSiblings'],
    siblingDetailBase: opts.siblingDetailBase as PartialSettings['siblingDetailBase'],
    // Flags name the old version whole: a --branch on the command line is not paired
    // with a commit the config names for another branch.
    ...(asksGit(opts)
      ? { baseHead: true, baseBranch: opts.branch ?? null, baseCommit: opts.commit ?? null }
      : {}),
  };
  return overridesFrom(values, (spec) => spec.flag);
}

/** `-a`: each hunk is shown as it is made, and kept unless the answer is no — Enter
 *  keeps it. The answers may come from a terminal or be piped in, one line per hunk; an
 *  input that closes before every hunk is answered stops the run. No offers to write the
 *  hunks by hand; refused, the run stops without a patch. */
function hunkReviewer(answers: Answers): Steering['review'] {
  return async (hunk, number, total) => {
    const answer = await answers.next(`\n${describeHunk(hunk, number - 1, total)}\nkeep this hunk? [Y/n] `);
    if (answer === null) throw new InputClosed();
    return /^\s*n/i.test(answer) ? 'decline' : 'keep';
  };
}

/** How a run with a person in it goes on when a hunk has to be written by hand: the
 *  reason is shown, the person asked, and the patch so far opened in their editor. */
function steering(answers: Answers, log: Logger, session: EditSession, review?: Steering['review']): Steering {
  return {
    review,
    async offerEdit(why) {
      log.note(why);
      if (!atTerminal()) {
        log.note('  writing hunks by hand needs a terminal: stopping, nothing is written');
        return false;
      }
      const answer = await answers.next(`  edit the hunks by hand (${editorCommand()})? [y/N] `);
      return answer !== null && /^\s*y(es)?\s*$/i.test(answer);
    },
    edit: (text) => session.edit(text),
  };
}

function makeTracer(log: Logger): Tracer {
  const write = (line: string): void => log.trace(line);
  const indent = (s: string): string => s.replace(/^/gm, '        ');
  const kindOf = (e: Extract<SynthEvent, { kind: 'segment' }>): string =>
    e.seg.removed.length > 0 && e.seg.added.length > 0 ? 'replace' : e.seg.added.length > 0 ? 'insert' : 'delete';
  return (e) => {
    if (e.kind === 'segment') {
      write(`\n── segment #${e.index + 1} (${kindOf(e)}) @ old line ${e.seg.oldStart}`);
      for (const l of e.seg.removed) write(`   - ${l}`);
      for (const l of e.seg.added) write(`   + ${l}`);
    } else if (e.kind === 'attempt') {
      const tag =
        e.result === 'unique'
          ? '✓ unique'
          : e.result === 'ambiguous'
            ? `✗ ambiguous (${e.matches}+ matches — need more context)`
            : '∅ no match';
      write(`   try → ${tag}\n${indent(printPattern(e.pattern))}`);
    } else {
      write(`   ➜ CHOSEN, patch: ${JSON.stringify(e.patch)}`);
    }
  };
}

/** A usage question, answered before a single file is opened: a wrong invocation has
 *  to be told apart from a file that is not there. */
function requireOneOldSource(opts: Options, config: ResolvedConfig): void {
  const one = `exactly one source of the OLD version: --in-old <file>, or git (${GIT_FLAG_NAMES})`;
  if (opts.inOld !== undefined && asksGit(opts)) throw new Error(`provide ${one} — not both`);
  if (opts.inOld === undefined && !basesOnGit(config.generate)) {
    throw new Error(`provide ${one}, or set generate.base in ${CONFIG_FILE_NAME}`);
  }
}

/** --in-old wins over a git base the config names; git flags have already replaced the
 *  config's coordinates (flagOverrides), so the settings hold the git source either way. */
async function oldVersion(opts: Options, settings: ResolvedConfig['generate'], inPath: string, ask: Ask): Promise<FileVersion> {
  if (opts.inOld !== undefined) return { text: readInputFile(opts.inOld, '--in-old'), spec: opts.inOld };
  return fileFromGit({ ...gitSourceOf(settings), path: opts.repoPath }, inPath, ask);
}

async function run(opts: Options, log: Logger, seen: Seen): Promise<void> {
  const { config, project } = loadProject({
    path: opts.in,
    search: { explicitPath: opts.config, cwd: process.cwd() },
    useFile: opts.useConfig,
    flags: flagOverrides(opts),
  });
  if (opts.printConfig) {
    process.stdout.write(formatConfig(config));
    return;
  }
  if (log.logPath !== undefined) log.trace(formatConfig(config).trimEnd());
  const answers = answersFrom();
  try {
    await generate(opts, config, project, log, seen, answers);
  } finally {
    answers.close();
  }
}

async function generate(
  opts: Options,
  config: ResolvedConfig,
  project: Project,
  log: Logger,
  seen: Seen,
  answers: Answers,
): Promise<void> {
  if (opts.in === undefined) throw new Error('missing --in <file> (new version)');
  requireOneOldSource(opts, config);

  const settings = config.generate;
  const ask = terminalAsker(opts.yes, (m) => log.note(m), answers);
  // before anything is read: a place the patch cannot go is known without it
  const out = resolveOutPath({ inPath: resolve(opts.in), out: settings.out, project });
  if (out.path !== undefined) checkParent(out.path);
  const target = patchTarget(project, out.path, opts.in);
  if (out.path !== undefined && !namedOutright(opts.out)) await mayWriteOver(out.path, target, ask);

  const newStr = readInputFile(opts.in, '--in');
  const old = await oldVersion(opts, config.generate, opts.in, ask);
  seen.old = old;
  log.trace(`old version: ${old.spec} (${old.text.length} bytes)`);
  const request: GenerateRequest = {
    oldText: old.text,
    newText: newStr,
    language: settings.language ?? undefined,
    path: opts.in,
    exact: settings.exact,
    bridgeGap: settings.bridgeGap,
    limits: settings,
    trace: opts.debug || log.logPath !== undefined ? makeTracer(log) : undefined,
    target,
    baseBlob: old.blob,
  };
  const session = editSession();
  let outcome: GenerateOutcome;
  try {
    outcome = await synthesizeFor(opts, request, () => steering(answers, log, session, hunkReviewer(answers)), () =>
      steering(answers, log, session),
    );
  } catch (e) {
    if (session.file !== undefined) log.note(`the hunks as last edited are kept in ${session.file}`);
    throw e;
  }
  session.discard();

  for (const w of outcome.warnings) log.note(`warning: ${w}`);

  const outPath = out.path;
  if (outPath === undefined) {
    process.stdout.write(outcome.md);
    return;
  }
  ensureParent(outPath);
  writeFileAtomic(outPath, outcome.md);
  log.note(`generated ${outcome.hunkCount} hunk(s) → ${outPath}`);
}

/** `--out x.hatch`: the person named the file, and writes over it. */
function namedOutright(out: string | undefined): boolean {
  return out !== undefined && !/[/\\]$/.test(out) && isPatchPath(out);
}

/** A place hatch computed holds a patch of ANOTHER file: two files met at one name
 *  (`out` changed, a flat directory). Regenerating the same file's patch is not asked
 *  about; this is, and with nobody to answer it is refused. */
async function mayWriteOver(path: string, target: string | undefined, ask: Ask): Promise<void> {
  const there = patchAt(path);
  if (!there.exists || there.target === (target ?? null)) return;
  const whose = there.target === null ? 'a file that names no Target' : `the patch of ${there.target}`;
  if (await ask(`${path} holds ${whose}, not of ${target ?? 'this file'}: it would be written over`)) return;
  throw new ConfigError(`${path} holds ${whose} — nothing written`, undefined);
}

/** `-a` steers from the first hunk. Without it synthesis runs on its own, and only a
 *  change it cannot anchor, with a person at a terminal, hands the run over — a script
 *  or CI gets the error as before. */
async function synthesizeFor(
  opts: Options,
  request: GenerateRequest,
  reviewed: () => Steering,
  unreviewed: () => Steering,
): Promise<GenerateOutcome> {
  if (opts.agreement) return generatePatch({ ...request, steering: reviewed() });
  try {
    return await generatePatch(request);
  } catch (e) {
    if (!(e instanceof SynthesisError) || e.reason === 'unreproduced' || !atTerminal()) throw e;
    return generatePatch({ ...request, steering: unreviewed() });
  }
}

interface Seen {
  old?: FileVersion;
}

export function main(argv: readonly string[]): Promise<void> {
  return runCommand(
    { name: 'generate', usage: USAGE, spec: SPEC, initial: INITIAL, verbose: (o) => o.debug, run, errorContext },
    argv,
  );
}

function errorContext(opts: Options, seen: Seen): ErrorContext {
  if (seen.old !== undefined) return { source: seen.old.text, sourcePath: seen.old.spec };
  return opts.inOld !== undefined ? { sourcePath: opts.inOld } : {};
}
