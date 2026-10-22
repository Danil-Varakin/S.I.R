import { FORMAT_MIN, FORMAT_VERSION } from '../core/header.ts';
import { reportFatal } from '../infra/log.ts';
import { packageIdentity } from '../infra/version.ts';
import { adaptersByName } from '../lang/adapter.ts';
import type { ArgSpec } from './args.ts';
import { pickOptions } from './args.ts';
import { INITIAL, SPEC, errorContext, runApply } from './apply.ts';
import type { Options } from './apply.ts';
import { runCommand } from './command.ts';
import { GIT_ARGS, GIT_USAGE } from './git-source.ts';

// `hatch-apply`: what a project's build runs to lay its patches on the code — the engine
// of `hatch apply`, in one executable with Node, the tree-sitter runtime and the
// grammars inside. Two commands, and no questions: in a build nobody answers, so what
// `hatch` would ask about is refused, and the base is a clean one — out of git, or the
// files on disk when the build says so (--base-from-disk).
//
// Its flags are a subset of `hatch apply`'s, with the same meaning (VERSIONING.md F2).

const COMMON = `  --match, -m <file>      the patch, a .hatch file                       [required]
  --in,    -i <file>      the file to patch; left out, the file the patch names in
                          its Target (from the upstream of the project, else from
                          the repository around the patch)

The base the patch is laid on is clean, always. Where the text below says a thing is
asked about, hatch-apply asks nothing: it is refused.

${GIT_USAGE}

  Without a git coordinate: generate.base of the project's hatch.config.json.
  --base-from-disk        the files on disk ARE the clean base: patch them as they are

  --config <file>         the config instead of the one up from the patch
  --no-config             none (then --in is required)
  --language, -l <lang>   force language (else: '# match <lang>' in the patch, else
                          the file extension)
  --log [place]           also write a full log
  --help,  -h             this help`;

const APPLY_USAGE = `hatch-apply apply — lay a .hatch patch on its file

  --out,   -o <path>      where to write the result; left out, the file itself.
                          A directory gets <name of --in> inside it; \`-\` is stdout.
                          A file that already holds the result is not written again;
                          one with changes of its own is written over and said so —
                          the code a build patches is not the project's to keep
${COMMON}`;

const VERIFY_USAGE = `hatch-apply verify — does the patch apply cleanly? Writes nothing; exit 0 if so

${COMMON}`;

const USAGE = `hatch-apply — apply .hatch patches in a build: no Node, no network, no questions

  hatch-apply apply  --match <patch> [--out <path>] [options]
  hatch-apply verify --match <patch> [options]
  hatch-apply --version     the version, the Node inside, the grammar pins
  hatch-apply <command> --help

Exit codes: 0 ok · 1 usage or a refusal · 2 patch parse · 3 no match · 4 ambiguous ·
5 config, or no clean base · 6 grammar`;

/** The options of `hatch apply` that `hatch-apply` takes — picked out of its spec, so
 *  each has the same meaning there and none can exist here alone (VERSIONING.md F2). */
const COMMON_OPTIONS = [
  ...Object.keys(GIT_ARGS.flags),
  ...Object.keys(GIT_ARGS.values),
  '--match', '-m',
  '--in', '-i',
  '--language', '-l',
  '--config', '--no-config',
  '--base-from-disk',
  '--log',
  '--help', '-h',
] as const;

/** `apply` writes, `verify` does not: only `apply` takes `--out`. */
export function binSpec(command: 'apply' | 'verify'): ArgSpec<Options> {
  return pickOptions(SPEC, command === 'apply' ? [...COMMON_OPTIONS, '--out', '-o'] : COMMON_OPTIONS);
}

/** `--version`: what a build pins when it records which tool it used. */
function versionText(): string {
  const pins = new Map<string, string>();
  for (const adapter of adaptersByName().values()) {
    const g = adapter.grammar;
    if (g === undefined) continue; // read as text: nothing pinned
    pins.set(g.file, `${g.file} ${g.package}@${g.version} sha256:${g.sha256}`);
  }
  return [
    `hatch-apply ${packageIdentity().version} (patch format ${FORMAT_MIN}–${FORMAT_VERSION}, node ${process.versions.node})`,
    ...[...pins.values()].sort().map((p) => `  ${p}`),
  ].join('\n');
}

export async function main(argv: readonly string[]): Promise<void> {
  const [first, ...rest] = argv;
  try {
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    if (first === '--version' || first === '-V' || first === 'version') {
      process.stdout.write(`${versionText()}\n`);
      return;
    }
    if (first !== 'apply' && first !== 'verify') {
      process.stderr.write(`error: unknown command '${first}' — apply or verify\n\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    const verify = first === 'verify';
    await runCommand(
      {
        name: `hatch-apply ${first}`,
        usage: verify ? VERIFY_USAGE : APPLY_USAGE,
        spec: binSpec(first),
        initial: { ...INITIAL, verify },
        run: (opts, log, seen) => runApply(opts, log, seen, 'hatch-apply'),
        errorContext,
      },
      rest,
    );
  } catch (e) {
    process.exitCode = reportFatal(e);
  }
}
