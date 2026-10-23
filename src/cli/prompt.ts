import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

// one line per question. ONE reader per run, not one per question: a pipe delivers
// several lines at once, and a reader closed after the first answer would throw the
// rest away.

export interface Answers {
  next(prompt: string): Promise<string | null>;
  close(): void;
}

export function answersFrom(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Answers {
  let rl: Interface | null = null;
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;

  const open = (): void => {
    if (rl !== null || closed) return;
    rl = createInterface({ input, terminal: false });
    rl.on('line', (line) => {
      const take = waiting.shift();
      if (take !== undefined) take(line);
      else lines.push(line);
    });
    rl.on('close', () => {
      closed = true;
      for (const take of waiting.splice(0)) take(null);
    });
  };

  return {
    next(prompt) {
      output.write(prompt);
      open();
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() {
      closed = true;
      rl?.close();
    },
  };
}
