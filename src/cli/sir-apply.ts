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

const COMMON = `  --match, -m <file>      the patch, a .sirp file                       [required]
  --in,    -i <file>      the file to patch; left out, the file the patch names in
                          its Target (from the upstream of the project, else from
                          the repository around the patch)

The base the patch is laid on is clean, always. Where the text below says a thing is
asked about, sir-apply asks nothing: it is refused.

${GIT_USAGE}

  Without a git coordinate: generate.base of the project's sir.config.json.
  --base-from-disk        the files on disk ARE the clean base: patch them as they are

  --config <file>         the config instead of the one up from the patch
  --no-config             none (then --in is required)
  --language, -l <lang>   force language (else: '# match <lang>' in the patch, else
                          the file extension)
  --log [place]           also write a full log
  --help,  -h             this help`;

const APPLY_USAGE = `sir-apply apply — lay a .sirp patch on its file

  --out,   -o <path>      where to write the result; left out, the file itself.
                          A directory gets <name of --in> inside it; \`-\` is stdout.
                          A file that already holds the result is not written again;
                          one with changes of its own is written over and said so —
                          the code a build patches is not the project's to keep
${COMMON}`;

const VERIFY_USAGE = `sir-apply verify — does the patch apply cleanly? Writes nothing; exit 0 if so

${COMMON}`;

const USAGE = `sir-apply — apply .sirp patches in a build: no Node, no network, no questions

  sir-apply apply  --match <patch> [--out <path>] [options]
  sir-apply verify --match <patch> [options]
  sir-apply --version     the version, the Node inside, the grammar pins
  sir-apply <command> --help

Exit codes: 0 ok · 1 usage or a refusal · 2 patch parse · 3 no match · 4 ambiguous ·
5 config, or no clean base · 6 grammar`;

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

export function binSpec(command: 'apply' | 'verify'): ArgSpec<Options> {
  return pickOptions(SPEC, command === 'apply' ? [...COMMON_OPTIONS, '--out', '-o'] : COMMON_OPTIONS);
}

function versionText(): string {
  const pins = new Map<string, string>();
  for (const adapter of adaptersByName().values()) {
    const g = adapter.grammar;
    if (g === undefined) continue;
    pins.set(g.file, `${g.file} ${g.package}@${g.version} sha256:${g.sha256}`);
  }
  return [
    `sir-apply ${packageIdentity().version} (patch format ${FORMAT_MIN}–${FORMAT_VERSION}, node ${process.versions.node})`,
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
        name: `sir-apply ${first}`,
        usage: verify ? VERIFY_USAGE : APPLY_USAGE,
        spec: binSpec(first),
        initial: { ...INITIAL, verify },
        run: (opts, log, seen) => runApply(opts, log, seen, 'sir-apply'),
        errorContext,
      },
      rest,
    );
  } catch (e) {
    process.exitCode = reportFatal(e);
  }
}
