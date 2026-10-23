import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { ProgressMessage, ResponseMessage } from './protocol.ts';
import { Session, handle } from './handler.ts';

export async function serve(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const session = new Session();
  const running = new Set<Promise<void>>();
  let flushed = true;
  output.on('drain', () => {
    flushed = true;
  });
  const send = (message: ResponseMessage | ProgressMessage): void => {
    if (!output.write(`${JSON.stringify(message)}\n`)) flushed = false;
  };

  for await (const line of jsonLines(input)) {
    if (!flushed) await once(output, 'drain');
    if (line.trim() === '') continue;

    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch (e) {
      send({
        id: 0,
        ok: false,
        error: { kind: 'BadRequest', message: `not JSON: ${(e as Error).message}`, exitCode: 1 },
        elapsedMs: 0,
      });
      continue;
    }

    const job = handle(request, send, session)
      .then(send)
      .catch((e: unknown) => {
        process.stderr.write(`sir service: ${(e as Error).message ?? String(e)}\n`);
      });
    running.add(job);
    void job.finally(() => running.delete(job));
  }
  await Promise.all(running);
}

/** The lines of the protocol: cut at `\n` alone, a `\r` before it dropped. Not
 *  `readline`, which also ends a line at U+2028 and U+2029 — characters JSON leaves
 *  unescaped inside a string, so a valid request holding one was cut in two. */
async function* jsonLines(input: NodeJS.ReadableStream): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    let from = pending.length;
    pending += text;
    let start = 0;
    for (let end = pending.indexOf('\n', from); end !== -1; end = pending.indexOf('\n', from)) {
      yield pending.slice(start, end).replace(/\r$/, '');
      start = end + 1;
      from = start;
    }
    pending = pending.slice(start);
  }
  pending += decoder.end();
  if (pending !== '') yield pending.replace(/\r$/, '');
}

// Started as a file — `node dist/service/index.js`, the way the VS Code extension 0.0.1
// starts it — it serves; imported, it does nothing. The entry of record is
// dist/bin/service.js. (Only this module checks: the service is not bundled into
// sir-apply, where every module would look "started".)
if (startedAsFile(import.meta.url)) await serve();

function startedAsFile(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
