import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { CONFIG_FILE_NAME, CONFIG_VERSION, configTemplate, suggestedConfigPath } from '../infra/config/index.ts';
import { checkParent, isDirectory, isFile, writeFileAtomic } from '../infra/fs.ts';
import type { ArgSpec } from './args.ts';
import { parseCountValue } from './args.ts';
import { runCommand } from './command.ts';

interface Options {
  configVersion?: string;
  dir?: string;
  upstream?: string;
  out?: string;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

const USAGE = `sir init — write a sir.config.json

Writes only "$schema" and "version": every other key keeps the built-in default until
you set it, so a later change of a default reaches the project.

  --config-version <n>  config schema to write (default: the newest this sir reads)
  --dir <dir>           where to write it (default: the root of the git repository
                        around the current directory; outside one, the directory itself)
  --upstream <path>     the project patches code it does not own: the root of that
                        code, from the config's directory (".." for a project inside
                        it, "chromium" for one inside the project, "." for patches
                        kept in a tree of their own in one repository). Written as
                        "upstream", with generate.out (default "patches") beside it
  --out <dir>           with --upstream: the patch tree, from the config's directory
  --force               replace an existing sir.config.json
  --dry-run             print the file to stdout, write nothing
  --help, -h            this help`;

const SPEC: ArgSpec<Options> = {
  flags: { '--force': 'force', '--dry-run': 'dryRun', '--help': 'help', '-h': 'help' },
  values: { '--config-version': 'configVersion', '--dir': 'dir', '--upstream': 'upstream', '--out': 'out' },
};

async function run(opts: Options): Promise<void> {
  const version = opts.configVersion === undefined ? undefined : parseCountValue(opts.configVersion);
  if (opts.out !== undefined && opts.upstream === undefined) {
    throw new Error('--out goes with --upstream; without it generate.out is set in the file by hand');
  }
  const target = opts.dir !== undefined ? join(resolve(opts.dir), CONFIG_FILE_NAME) : suggestedConfigPath(process.cwd());
  const settings =
    opts.upstream === undefined ? undefined : { upstream: opts.upstream, generate: { out: opts.out ?? 'patches' } };
  if (opts.upstream !== undefined && !isDirectory(resolve(dirname(target), opts.upstream))) {
    throw new ConfigError(`--upstream ${opts.upstream} names no directory from ${dirname(target)}`, target);
  }
  const template = configTemplate({ version, settings });

  if (opts.dryRun) {
    process.stdout.write(template.text);
  } else {
    if (isFile(target) && !opts.force) {
      throw new ConfigError('already exists — nothing written; --force replaces it', target);
    }
    checkParent(target);
    writeFileAtomic(target, template.text);
    process.stderr.write(`wrote ${target}\n`);
  }
  const note = olderSchemaNote(template.version, opts.dryRun);
  if (note !== undefined) process.stderr.write(`${note}\n`);
}

export function olderSchemaNote(written: number, dryRun = false): string | undefined {
  if (written >= CONFIG_VERSION) return undefined;
  return `${dryRun ? 'printed' : 'wrote'} config schema v${written}; the newest is v${CONFIG_VERSION}`;
}

export function main(argv: readonly string[]): Promise<void> {
  return runCommand(
    { name: 'init', usage: USAGE, spec: SPEC, initial: { force: false, dryRun: false, help: false }, run },
    argv,
  );
}
