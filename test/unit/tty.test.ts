import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// What sir does only with a person at a terminal — the editor offered when synthesis
// cannot anchor a change, the yes/no questions — run for real: sir in a process of its
// own, which `test/fake-tty.mjs` makes take its stdin and stderr for a terminal. The
// answers come down a pipe, the editor is a command that puts a prepared text into the
// file it is given (`VISUAL`).

const SIR = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));
const FAKE_TTY = fileURLToPath(new URL('../fake-tty.mjs', import.meta.url));

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function sir(dir: string, args: string[], opts: { tty?: boolean; input?: string; visual?: string } = {}): Run {
  const r = spawnSync(
    'node',
    ['--experimental-strip-types', '--no-warnings', ...(opts.tty === true ? ['--import', FAKE_TTY] : []), SIR, ...args],
    {
      cwd: dir,
      encoding: 'utf8',
      input: opts.input ?? '',
      env: { ...process.env, VISUAL: opts.visual ?? 'false', EDITOR: '' },
    },
  );
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// Two identical if-blocks, the change in the second: synthesis cannot anchor it.
const TWIN_OLD = 'void f() {\n  if (cond) {\n    a();\n    work();\n  }\n  if (cond) {\n    a();\n    work();\n  }\n}\n';
const TWIN_NEW = TWIN_OLD.replace(/work\(\);(?![\s\S]*work\(\);)/, 'work(2);');
const BY_HAND = [
  '# match cpp',
  '    ...',
  '    if (cond) {',
  '    ...',
  '    }',
  '    ...',
  '    if (cond) {',
  '    ...',
  '    >>>',
  '    work();',
  '    <<<',
  '    ...',
  '# end',
  '# patch',
  '    work(2);',
  '# end',
  '',
].join('\n');
const OFFER = /edit the hunks by hand \(.*\)\? \[y\/N\] /;

function project(): { dir: string; done: () => void; editorWriting: (text: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'sir-tty-'));
  writeFileSync(join(dir, 'old.cc'), TWIN_OLD);
  writeFileSync(join(dir, 'new.cc'), TWIN_NEW);
  let n = 0;
  return {
    dir,
    done: () => rmSync(dir, { recursive: true, force: true }),
    // an "editor" that writes `text` over the file it is opened on
    editorWriting: (text) => {
      const source = join(dir, `editor-${++n}.txt`);
      writeFileSync(source, text);
      return `cp '${source}'`;
    },
  };
}

const GENERATE = ['generate', '--in-old', 'old.cc', '--in', 'new.cc', '--out', 'p.sirp'];

// ── generate without -a: the editor is offered only at a terminal ─────────────────────

test('tty: a change synthesis cannot anchor — at a terminal the editor is offered; yes, and the hand hunk is written', () => {
  const p = project();
  try {
    const r = sir(p.dir, GENERATE, { tty: true, input: 'y\n', visual: p.editorWriting(BY_HAND) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /hunk 1: the change at line 8 could not be anchored — ambiguous match/);
    assert.match(r.stderr, OFFER);
    assert.ok(readFileSync(join(p.dir, 'p.sirp'), 'utf8').endsWith(BY_HAND), 'the hand hunk, as written');
    const back = sir(p.dir, ['apply', '--match', 'p.sirp', '--in', 'old.cc', '--out', 'back.cc']);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(readFileSync(join(p.dir, 'back.cc'), 'utf8'), TWIN_NEW);
  } finally {
    p.done();
  }
});

test('tty: the editor offered, and declined — the synthesis error, exit 8, nothing written', () => {
  const p = project();
  try {
    const r = sir(p.dir, GENERATE, { tty: true, input: 'n\n', visual: p.editorWriting(BY_HAND) });
    assert.equal(r.status, 8, r.stderr);
    assert.match(r.stderr, OFFER);
    assert.match(r.stderr, /SynthesisError: could not anchor the change at line 8/);
    assert.equal(existsSync(join(p.dir, 'p.sirp')), false);
  } finally {
    p.done();
  }
});

test('tty: the input closing on the offer is a no', () => {
  const p = project();
  try {
    const r = sir(p.dir, GENERATE, { tty: true, input: '', visual: p.editorWriting(BY_HAND) });
    assert.equal(r.status, 8, r.stderr);
    assert.match(r.stderr, OFFER);
  } finally {
    p.done();
  }
});

test('tty: no terminal — no offer, the synthesis error as a script or CI has always had it', () => {
  const p = project();
  try {
    const r = sir(p.dir, GENERATE, { input: 'y\n', visual: p.editorWriting(BY_HAND) });
    assert.equal(r.status, 8, r.stderr);
    assert.doesNotMatch(r.stderr, /edit the hunks by hand/);
  } finally {
    p.done();
  }
});

test('tty: -a with no terminal — writing by hand needs one: stopping', () => {
  const p = project();
  try {
    const r = sir(p.dir, ['generate', '-a', ...GENERATE.slice(1)], { input: 'y\n' });
    assert.equal(r.status, 8, r.stderr);
    assert.match(r.stderr, /writing hunks by hand needs a terminal: stopping, nothing is written/);
  } finally {
    p.done();
  }
});

test('tty: an editor that fails — the run stops, and the file of the hunks is named so nothing typed is lost', () => {
  const p = project();
  try {
    const r = sir(p.dir, GENERATE, { tty: true, input: 'y\n', visual: 'false' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /the hunks as last edited are kept in .*hunks\.sirp/);
    assert.match(r.stderr, /error: the editor \(false\) exited with 1 — nothing was written\n {2}set VISUAL or EDITOR to the editor to use/);
    assert.equal(existsSync(join(p.dir, 'p.sirp')), false);
  } finally {
    p.done();
  }
});

test('tty: an edit that does not stand is offered again with its reason; no — the run stops', () => {
  const p = project();
  try {
    const r = sir(p.dir, GENERATE, { tty: true, input: 'y\nn\n', visual: p.editorWriting('garbage\n') });
    assert.equal(r.status, 1, r.stderr);
    assert.equal((r.stderr.match(OFFER) ?? []).length, 1, 'the first offer');
    assert.equal(r.stderr.split('edit the hunks by hand').length - 1, 2, 'and the second, after the reason');
    assert.match(r.stderr, /the edited patch does not parse: line 1: no match\/patch pairs were found in the file$/m);
    assert.match(r.stderr, /the hunks as last edited are kept in /);
    assert.match(r.stderr, /nothing was written/);
  } finally {
    p.done();
  }
});

// ── the yes/no questions ─────────────────────────────────────────────────────────────

const PATCH_A_TO_B = 'Sir: 2\n\n# match cpp\n    >>>\n    int a;\n    <<<\n    ...\n# end\n# patch\n    int b;\n# end\n';

test('tty: apply --verify with no git base asks whether the files on disk are the base — yes checks, no refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-tty-'));
  try {
    writeFileSync(join(dir, 'a.cc'), 'int a;\n');
    writeFileSync(join(dir, 'p.sirp'), PATCH_A_TO_B);
    const args = ['apply', '--verify', '--match', 'p.sirp', '--in', 'a.cc'];
    const question = /--verify names no base out of git: are the files on disk the clean base to check against\?\n {2}go ahead\? \[y\/N\] /;

    const yes = sir(dir, args, { tty: true, input: 'y\n' });
    assert.equal(yes.status, 0, yes.stderr);
    assert.match(yes.stderr, question);
    assert.match(yes.stdout, /verify: ok — 1 hunk\(s\) apply cleanly/, 'the result to stdout, the question to stderr');

    const no = sir(dir, args, { tty: true, input: 'n\n' });
    assert.equal(no.status, 1, no.stderr);
    assert.match(no.stderr, question);
    assert.match(no.stderr, /error: --verify needs a clean base/);

    const away = sir(dir, args, { input: 'y\n' });
    assert.equal(away.status, 1, away.stderr);
    assert.match(away.stderr, /not a terminal, so nobody can answer: stopping \(pass --yes to go ahead\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tty: generate over a patch of another file asks; yes writes over it, no and no terminal refuse, --yes goes ahead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-tty-'));
  try {
    writeFileSync(join(dir, 'o.cc'), 'int a;\n');
    writeFileSync(join(dir, 'n.cc'), 'int b;\n');
    mkdirSync(join(dir, 'outd'));
    const there = join(dir, 'outd', 'n.cc.sirp');
    const other = (): void => writeFileSync(there, `Sir: 2\nTarget: other.cc\n\n${PATCH_A_TO_B.slice('Sir: 2\n\n'.length)}`);
    const args = ['generate', '--in-old', 'o.cc', '--in', 'n.cc', '--out', 'outd/'];
    const question = /holds the patch of other\.cc, not of this file: it would be written over\n {2}go ahead\? \[y\/N\] /;

    other();
    const yes = sir(dir, args, { tty: true, input: 'y\n' });
    assert.equal(yes.status, 0, yes.stderr);
    assert.match(yes.stderr, question);
    assert.doesNotMatch(readFileSync(there, 'utf8'), /other\.cc/);

    other();
    const no = sir(dir, args, { tty: true, input: 'n\n' });
    assert.equal(no.status, 5, no.stderr);
    assert.match(no.stderr, /ConfigError: .*n\.cc\.sirp holds the patch of other\.cc — nothing written/);
    assert.match(readFileSync(there, 'utf8'), /Target: other\.cc/, 'left as it was');

    const away = sir(dir, args, {});
    assert.equal(away.status, 5, away.stderr);
    assert.match(away.stderr, /not a terminal, so nobody can answer/);

    const sure = sir(dir, [...args, '--yes'], {});
    assert.equal(sure.status, 0, sure.stderr);
    assert.match(sure.stderr, /--yes: going ahead/);

    other();
    const named = sir(dir, ['generate', '--in-old', 'o.cc', '--in', 'n.cc', '--out', 'outd/n.cc.sirp'], {});
    assert.equal(named.status, 0, 'a file named outright is written over without a question');
    assert.doesNotMatch(named.stderr, /would be written over/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── what --debug, --log and --dry-run tell ───────────────────────────────────────────

test('generate --debug: a candidate that fits nowhere is told as no match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-tty-'));
  try {
    // the change opens `[`: the closer of `def b` past it, with no `]`, fits nowhere
    const old = 'def b(rows):\n    return [\n        x\n        for x in rows\n    ]\n\n\ndef a(rows):\n    return list(rows)\n';
    writeFileSync(join(dir, 'o.py'), old);
    writeFileSync(join(dir, 'n.py'), old.replace('return [', 'yield ['));
    const r = sir(dir, ['generate', '--debug', '--in-old', 'o.py', '--in', 'n.py', '--out', '-']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /try → ∅ no match/);
    assert.match(r.stderr, /try → ✓ unique/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate --log: the config in effect is written to the log first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-tty-'));
  try {
    writeFileSync(join(dir, 'o.cc'), 'int a;\n');
    writeFileSync(join(dir, 'n.cc'), 'int b;\n');
    const r = sir(dir, ['generate', '--log', 'run.log', '--in-old', 'o.cc', '--in', 'n.cc', '--out', '-']);
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(dir, 'run.log'), 'utf8');
    assert.match(log, /^# sir generate$/m);
    assert.match(log, /generate\.exact/, 'the settings, as --print-config shows them');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply --dry-run: each hunk told as INSERT at a point or REPLACE of a range, with what it replaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-tty-'));
  try {
    writeFileSync(join(dir, 'a.cc'), 'int a;\n');
    writeFileSync(join(dir, 'p.sirp'), PATCH_A_TO_B + '\n# match cpp\n    ...\n    >>>\n# end\n# patch\n    int c;\n\n# end\n');
    const r = sir(dir, ['apply', '--dry-run', '--match', 'p.sirp', '--in', 'a.cc']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      'hunk 1/2:\n  REPLACE [0, 6)\n    new: "int b;"\n    old: "int a;"\n' +
        'hunk 2/2:\n  INSERT @7\n    new: "int c;\\n"\n' +
        'dry-run: 2 hunk(s) would apply (nothing written)\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
