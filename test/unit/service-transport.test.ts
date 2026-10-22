import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';

import { serve } from '../../src/service/index.ts';

// The transport of the service (`service/index.ts`), with streams of the test's making:
// a client that reads slowly, an output that breaks, a last line with no newline.

const VERSION = (id: number): string => JSON.stringify({ id, method: 'version' });

function ids(lines: string[]): number[] {
  return lines.map((l) => (JSON.parse(l) as { id: number }).id);
}

test('service: a client that stops reading stops being read from — every reply arrives, none is lost', async () => {
  const written: string[] = [];
  let reads = 0;
  // one request per chunk, counted as it is taken
  const input = new Readable({
    read() {
      reads++;
      this.push(reads <= 5 ? `${VERSION(reads)}\n` : null);
    },
  });
  // a buffer of one byte: every reply fills it, and it drains only later
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _enc, done) {
      setTimeout(() => {
        written.push(String(chunk).trimEnd());
        done();
      }, 5);
    },
  });
  let lowestBacklog = Infinity;
  output.on('drain', () => (lowestBacklog = Math.min(lowestBacklog, output.writableLength)));
  await serve(input, output);
  await new Promise<void>((resolve) => output.end(resolve));
  assert.deepEqual(ids(written).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(lowestBacklog, 0, 'the output drained — the service waited for it');
});

test('service: the last line needs no newline', async () => {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _enc, done) {
      lines.push(...String(chunk).split('\n').filter((l) => l !== ''));
      done();
    },
  });
  await serve(Readable.from([`${VERSION(1)}\n${VERSION(2)}`]), output);
  assert.deepEqual(ids(lines).sort(), [1, 2]);
});

test('service: a line cut over chunks, and CRLF line ends, read as one request each', async () => {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _enc, done) {
      lines.push(...String(chunk).split('\n').filter((l) => l !== ''));
      done();
    },
  });
  const whole = `${VERSION(1)}\r\n${VERSION(2)}\n`;
  await serve(Readable.from([whole.slice(0, 7), whole.slice(7, 20), whole.slice(20)]), output);
  assert.deepEqual(ids(lines).sort(), [1, 2]);
});

/** process.stderr written to, for the length of `run`. */
async function stderrOf(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let text = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return text;
}

test('service: an output that breaks under a reply — told on stderr, the other requests still served', async () => {
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _enc, done) {
      written.push(String(chunk).trimEnd());
      done();
    },
  });
  const realWrite = output.write.bind(output);
  output.write = ((chunk: string, ...rest: never[]): boolean => {
    if (chunk.includes('"id":2')) throw new Error('the pipe is gone');
    return realWrite(chunk, ...rest);
  }) as typeof output.write;

  const said = await stderrOf(() => serve(Readable.from([`${VERSION(1)}\n${VERSION(2)}\n${VERSION(3)}\n`]), output));
  assert.equal(said, 'hatch service: the pipe is gone\n');
  assert.deepEqual(ids(written).sort(), [1, 3]);
});

test('service: a thrown value that is no Error is told by its text', async () => {
  const output = new Writable({ write: (_c, _e, done) => done() });
  output.write = ((): boolean => {
    throw 'just a string';
  }) as typeof output.write;
  const said = await stderrOf(() => serve(Readable.from([`${VERSION(1)}\n`]), output));
  assert.equal(said, 'hatch service: just a string\n');
});
