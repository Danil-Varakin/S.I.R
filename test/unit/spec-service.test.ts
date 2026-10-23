import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';

import { handle } from '../../src/service/handler.ts';
import { serve } from '../../src/service/index.ts';
import type { ProgressMessage, ResponseMessage, ServiceError } from '../../src/service/protocol.ts';
import type { HunkLink } from '../../src/core/resolve.ts';
import { sirMd } from '../helpers.ts';

const BASE = 'namespace f {\nvoid a() {\n  one();\n}\n}\n';

function ok(response: ResponseMessage): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: Record<string, unknown> }).result;
}

function failed(response: ResponseMessage): ServiceError {
  assert.equal(response.ok, false, JSON.stringify(response));
  return (response as { error: ServiceError }).error;
}

const call = (method: string, params: object, id = 1): Promise<ResponseMessage> => handle({ id, method, params });

async function served(lines: readonly string[]): Promise<(ResponseMessage | ProgressMessage)[]> {
  const out: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      out.push(String(chunk));
      done();
    },
  });
  await serve(Readable.from([`${lines.join('\n')}\n`]), sink);
  return out
    .join('')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as ResponseMessage | ProgressMessage);
}

const replies = (messages: readonly (ResponseMessage | ProgressMessage)[]): ResponseMessage[] =>
  messages.filter((m): m is ResponseMessage => !('method' in m));

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('transport: "a request whose id is not a number is answered with id: 0"', async () => {
  const messages = await served([
    JSON.stringify({ id: 'abc', method: 'version' }),
    JSON.stringify({ method: 'version' }),
    JSON.stringify({ id: null, method: 'version' }),
  ]);
  const ids = replies(messages).map((r) => r.id);
  assert.deepEqual(ids, [0, 0, 0]);
});

test('transport: "match replies to requests by id" — five generates at once, each reply is its own', async () => {
  const base = 'void f() {\n  int a = 0;\n}\n';
  const ids = [11, 12, 13, 14, 15];
  const lines = ids.map((id) =>
    JSON.stringify({ id, method: 'generate', params: { baseText: base, newText: base.replace('= 0', `= ${id}`), language: 'cpp' } }),
  );
  const answered = replies(await served(lines));
  assert.deepEqual(answered.map((r) => r.id).sort(), ids, 'one reply per request');
  for (const r of answered) {
    const patch = String(ok(r)['patch']);
    assert.match(patch, new RegExp(`int a = ${r.id};`), `reply ${r.id} carries its own request's change`);
    for (const other of ids.filter((i) => i !== r.id)) assert.doesNotMatch(patch, new RegExp(`int a = ${other};`));
  }
});

test('transport: a line separator (U+2028) inside a string does not break the line protocol', async () => {
  const newText = BASE.replace('one();', 'one(); // a b');
  const messages = await served([
    JSON.stringify({ id: 1, method: 'generate', params: { baseText: BASE, newText, language: 'cpp' } }),
    JSON.stringify({ id: 2, method: 'version' }),
  ]);
  const answered = replies(messages);
  assert.deepEqual(answered.map((r) => r.id).sort(), [1, 2]);
  assert.ok(String(ok(answered.find((r) => r.id === 1)!)['patch']).includes(' '));
});

test('transport: a request of several megabytes on one line is answered', async () => {
  const lines = Array.from({ length: 60_000 }, (_, i) => `int v${i} = ${i};`);
  const baseText = `${lines.join('\n')}\n`;
  const newText = baseText.replace('int v30000 = 30000;', 'int v30000 = -1;');
  const line = JSON.stringify({ id: 7, method: 'generate', params: { baseText, newText, language: 'cpp' } });
  assert.ok(line.length > 1_000_000, `${line.length} bytes`);
  const [reply] = replies(await served([line]));
  assert.equal(reply!.id, 7);
  assert.equal(ok(reply!)['reproducesNew'], true);
});

test('generate progress: "done of total, where total is known before synthesis starts" — one total, done never goes back', async () => {
  const old = Array.from({ length: 12 }, (_, i) => `int f${i}() {\n  return ${i};\n}\n`).join('');
  const neu = old.replace(/return (\d+);/g, 'return $1 + 1;');
  const progress: ProgressMessage[] = [];
  ok(await handle({ id: 3, method: 'generate', params: { baseText: old, newText: neu, language: 'cpp' } }, (m) => progress.push(m)));
  assert.ok(progress.length >= 1);
  const totals = new Set(progress.map((p) => p.params.total));
  assert.equal(totals.size, 1, `one total: ${[...totals].join(', ')}`);
  for (let i = 0; i < progress.length; i++) {
    const { done, total } = progress[i]!.params;
    assert.ok(done >= 0 && done <= total, `${done} of ${total}`);
    if (i > 0) assert.ok(done >= progress[i - 1]!.params.done, 'done does not go back');
  }
});

test('cancel: "the other methods do not stop: they answer as usual" — a resolve with a cancel behind it', async () => {
  const patch = sirMd([{ match: '...\none();\n>>>\n...', patch: 'two();' }]);
  const answered = replies(
    await served([
      JSON.stringify({ id: 1, method: 'resolve', params: { patch, baseText: BASE } }),
      JSON.stringify({ id: 2, method: 'cancel', params: { id: 1 } }),
    ]),
  );
  const resolve = answered.find((r) => r.id === 1)!;
  assert.equal((ok(resolve)['hunks'] as HunkLink[])[0]!.status, 'ok');
  assert.equal(typeof ok(answered.find((r) => r.id === 2)!)['cancelled'], 'boolean');
});

test('cancel: "cancel itself cannot be cancelled" — a cancel naming its own id answers cancelled: false', async () => {
  const [reply] = replies(await served([JSON.stringify({ id: 5, method: 'cancel', params: { id: 5 } })]));
  assert.deepEqual(ok(reply!), { cancelled: false });
});

test('apply: "apply still returns text — with the hunks that landed"', async () => {
  const patch = sirMd([
    { match: '...\none();\n>>>\n...', patch: 'two();' },
    { match: '...\nnosuch();\n>>>\n...', patch: 'three();' },
  ]);
  const result = ok(await call('apply', { patch, baseText: BASE }));
  const hunks = result['hunks'] as HunkLink[];
  assert.equal(hunks[0]!.status, 'ok');
  assert.equal(hunks[1]!.status, 'no-match');
  assert.equal(result['text'], BASE.replace('one();', 'one();two();'));
});

test('link table: "one entry per hunk, in the order of the .sirp"; index is the hunk\'s position', async () => {
  const patch = sirMd([
    { match: '...\nnamespace f {\n>>>\n...', patch: '\nint a;' },
    { match: '...\nnosuch();\n>>>\n...', patch: 'x();' },
    { match: '...\none();\n>>>\n...', patch: 'two();' },
  ]);
  const hunks = ok(await call('resolve', { patch, baseText: BASE }))['hunks'] as HunkLink[];
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks.map((h) => h.index - hunks[0]!.index), [0, 1, 2]);
  assert.deepEqual(hunks.map((h) => h.status), ['ok', 'no-match', 'ok']);
  for (let i = 1; i < hunks.length; i++) assert.ok(hunks[i]!.mdSpan![0] > hunks[i - 1]!.mdSpan![1]);
});

test('link table: "offsets are UTF-16 code units (JavaScript string indices), not bytes"', async () => {
  const base = `// 👋 привет 变量\n${BASE.replace('one();', 'log("🙂");\n  one();')}`;
  const patch = sirMd([{ match: '...\n>>>\none();\n<<<\n...', patch: 'uno();' }]);
  const result = ok(await call('apply', { patch, baseText: base, language: 'cpp' }));
  const link = (result['hunks'] as HunkLink[])[0]!;
  assert.equal(link.status, 'ok');
  assert.equal(base.slice(link.base!.start, link.base!.end), 'one();');
  const text = String(result['text']);
  assert.equal(text.slice(link.final!.start, link.final!.end), 'uno();');
  assert.equal(link.finalText, 'uno();');
});

test('errors: an unknown language is a LanguageError with detail.language, and exitCode 1 as the CLI', async () => {
  const error = failed(await call('generate', { baseText: BASE, newText: BASE.replace('one', 'two'), language: 'cobol' }));
  assert.equal(error.kind, 'LanguageError');
  assert.equal(error.exitCode, 1);
  assert.equal(error.detail?.['language'], 'cobol');
});

test('errors: GitError reasons from the list — no-repository, no-git', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sir-svc-norepo-')));
  try {
    const path = join(dir, 'a.cc');
    writeFileSync(path, BASE);
    const noRepo = failed(await call('generate', { path, newText: BASE.replace('one', 'two'), baseGit: {} }));
    assert.equal(noRepo.kind, 'GitError');
    assert.equal(noRepo.detail?.['reason'], 'no-repository');

    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    const empty = join(dir, 'empty-path');
    mkdirSync(empty);
    await withEnv({ PATH: empty }, async () => {
      const noGit = failed(await call('generate', { path, newText: BASE.replace('one', 'two'), baseGit: {} }));
      assert.equal(noGit.kind, 'GitError');
      assert.equal(noGit.exitCode, 1);
      assert.equal(noGit.detail?.['reason'], 'no-git');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version: protocolMin ≤ protocol, and languages hold every name and extension of README "Language support"', async () => {
  const v = ok(await call('version', {}));
  assert.ok((v['protocolMin'] as number) <= (v['protocol'] as number));
  assert.ok((v['configSchemaMin'] as number) <= (v['configSchema'] as number));
  const names = [
    'cpp', 'c++', 'cc', 'cxx', 'h', 'hpp', 'c', 'objc', 'objective-c', 'python', 'py', 'javascript', 'js', 'jsx',
    'typescript', 'ts', 'tsx', 'rust', 'rs', 'java', 'kotlin', 'kt', 'go', 'golang', 'html', 'xml', 'css', 'json', 'json5', 'idl', 'mojom', 'proto', 'protobuf', 'shell', 'yaml', 'toml', 'text',
  ];
  const extensions = ['cc', 'cpp', 'cxx', 'h', 'hpp', 'inc', 'c', 'm', 'mm', 'py', 'pyi', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'rs', 'java', 'kt', 'kts', 'go', 'html', 'htm', 'xml', 'plist', 'css', 'json', 'json5', 'star', 'webidl', 'sh', 'bash', 'yml', 'txt'];
  const languages = v['languages'] as string[];
  for (const name of [...names, ...extensions]) assert.ok(languages.includes(name), name);
});

test('generate: from an empty base, down to an empty text — reproducesNew; both empty — NoChanges', async () => {
  const into = ok(await call('generate', { baseText: '', newText: 'int a = 1;\n', language: 'cpp' }));
  assert.equal(into['reproducesNew'], true);
  const away = ok(await call('generate', { baseText: 'int a = 1;\n', newText: '', language: 'cpp' }));
  assert.equal(away['reproducesNew'], true);
  assert.equal(failed(await call('generate', { baseText: '', newText: '', language: 'cpp' })).kind, 'NoChanges');
});

test('generate: the same request twice gets the same answer', async () => {
  const params = { baseText: BASE, newText: BASE.replace('one();', 'one();\n  two();'), language: 'cpp' };
  const first = ok(await call('generate', params));
  const second = ok(await call('generate', params, 2));
  assert.deepEqual(second, first);
});

test('"the service takes text and writes no files" — generate, resolve, apply, pair and config in a project leave it as it was', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sir-svc-nowrite-')));
  const snapshot = (): string[] => {
    const all: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        all.push(`${p} ${statSync(p).mtimeMs}`);
        if (statSync(p).isDirectory()) walk(p);
      }
    };
    walk(dir);
    return all.sort();
  };
  try {
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'sir.config.json'), JSON.stringify({ version: 3, upstream: '.', generate: { out: 'patches' } }));
    const path = join(dir, 'src', 'a.cc');
    writeFileSync(path, BASE);
    const before = snapshot();
    const g = ok(await call('generate', { path, baseText: BASE, newText: BASE.replace('one', 'two') }));
    ok(await call('resolve', { path, patch: g['patch'], baseText: BASE }));
    ok(await call('apply', { path, patch: g['patch'], baseText: BASE }));
    ok(await call('pair', { path }));
    ok(await call('config', { path }));
    ok(await call('configTemplate', { path }));
    assert.deepEqual(snapshot(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
