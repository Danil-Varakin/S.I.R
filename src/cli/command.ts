import { createLoggerOrWarn, logHeader, resolveLogPath } from '../infra/log.ts';
import type { ErrorContext, Logger } from '../infra/log.ts';
import { parseArgs } from './args.ts';
import type { ArgSpec } from './args.ts';

export interface CommonOptions {
  help: boolean;
  log?: string;
}

export interface Command<T extends CommonOptions, Seen extends object> {
  readonly name: string;
  readonly usage: string;
  readonly spec: ArgSpec<T>;
  readonly initial: T;
  readonly verbose?: (opts: T) => boolean;
  readonly run: (opts: T, log: Logger, seen: Seen) => Promise<void>;
  readonly errorContext?: (opts: T, seen: Seen) => ErrorContext;
}

export async function runCommand<T extends CommonOptions, Seen extends object>(
  command: Command<T, Seen>,
  argv: readonly string[],
): Promise<void> {
  let opts: T;
  try {
    opts = parseArgs(argv, command.spec, { ...command.initial });
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n\n${command.usage}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    process.stdout.write(`${command.usage}\n`);
    return;
  }

  const log = createLoggerOrWarn({
    ...(opts.log !== undefined ? { logPath: resolveLogPath(opts.log, command.name) } : {}),
    ...(command.verbose !== undefined ? { verbose: command.verbose(opts) } : {}),
    header: logHeader(command.name, argv),
  });

  const seen = {} as Seen;
  try {
    await command.run(opts, log, seen);
    if (log.logPath !== undefined) log.note(`log: ${log.logPath}`);
  } catch (e) {
    process.exitCode = log.fail(e, command.errorContext?.(opts, seen));
  } finally {
    log.close();
  }
}
