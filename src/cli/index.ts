import { reportFatal } from '../infra/log.ts';
import { configRange } from '../infra/config/index.ts';
import { packageIdentity } from '../infra/version.ts';

interface Command {
  readonly summary: string;
  readonly load: () => Promise<{ main: (argv: readonly string[]) => Promise<void> }>;
}

// A Map, not an object literal: the command name is whatever was typed, and an object
// answers `constructor`, `toString` and `__proto__` with what it inherits.
const COMMANDS: ReadonlyMap<string, Command> = new Map([
  ['apply', { summary: 'apply a .sirp patch to a source file', load: () => import('./apply.ts') }],
  [
    'generate',
    { summary: 'synthesize a .sirp patch from two versions of a file', load: () => import('./generate.ts') },
  ],
  ['init', { summary: 'write a sir.config.json for the project', load: () => import('./init.ts') }],
]);

const USAGE = `sir — structural patches: found by the shape of the code, not by line numbers

  sir <command> [options]

Commands:
${[...COMMANDS]
  .map(([name, c]) => `  ${name.padEnd(10)}${c.summary}`)
  .join('\n')}

  sir <command> --help    options for that command
  sir --version           version of sir and of the config schema

Exit codes: 0 ok · 1 usage · 2 patch parse · 3 no match · 4 ambiguous · 5 config · 6 grammar · 7 no changes · 8 cannot anchor`;

export async function main(argv: readonly string[]): Promise<void> {
  const [first, ...rest] = argv;

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    const topic = first === 'help' ? rest[0] : undefined;
    const named = topic === undefined ? undefined : COMMANDS.get(topic);
    if (named !== undefined) {
      await (await named.load()).main(['--help']);
      return;
    }
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (first === '--version' || first === '-V' || first === 'version') {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const command = COMMANDS.get(first);
  if (command === undefined) {
    const known = [...COMMANDS.keys()].join(', ');
    const hint = first.startsWith('-')
      ? `options come AFTER the command: sir <command> ${first} …`
      : `known commands: ${known}`;
    process.stderr.write(`error: unknown command '${first}'\n  ${hint}\n\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const module = await command.load();
    await module.main(rest);
  } catch (e) {
    process.exitCode = reportFatal(e);
  }
}

function version(): string {
  const pkg = packageIdentity();
  return `${pkg.name} ${pkg.version} (config schema ${configRange()})`;
}
