import type { Ask } from '../infra/ask.ts';
import type { ArgSpec } from './args.ts';
import type { Answers } from './prompt.ts';

export interface ConfirmOptions {
  yes: boolean;
}

export const CONFIRM_ARGS = {
  flags: { '--yes': 'yes', '-y': 'yes' },
} as const satisfies ArgSpec<ConfirmOptions>;

export const CONFIRM_USAGE = `  --yes,    -y            answer yes in advance to every warning that asks before
                          going on. Without it the question goes to the terminal, and
                          where there is no terminal to answer (a pipe, CI) the
                          answer is no and the run stops`;

export interface AskerDeps {
  readonly yes: boolean;
  readonly interactive: boolean;
  readonly note: (message: string) => void;
  readonly prompt: (text: string) => Promise<string | null>;
}

export function asker(deps: AskerDeps): Ask {
  return async (question) => {
    deps.note(`warning: ${question}`);
    if (deps.yes) {
      deps.note('  --yes: going ahead');
      return true;
    }
    if (!deps.interactive) {
      deps.note('  not a terminal, so nobody can answer: stopping (pass --yes to go ahead)');
      return false;
    }
    const answer = await deps.prompt('  go ahead? [y/N] ');
    return answer !== null && /^\s*y(es)?\s*$/i.test(answer);
  };
}

/** A person at a terminal, who can both see a question and answer it: both ends must be
 *  a terminal — a question written into a redirected stderr would be answered blind. */
export function atTerminal(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

export function terminalAsker(yes: boolean, note: (message: string) => void, answers: Answers): Ask {
  return asker({
    yes,
    interactive: atTerminal(),
    note,
    prompt: (text) => answers.next(text),
  });
}
