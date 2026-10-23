import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { pathWithin, replacesFile, writeFileAtomic } from '../../src/infra/fs.ts';
import { targetFor } from '../../src/infra/pair.ts';

function inDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sir-fs-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('replacesFile: the same path, another file, a path that is not there', () => {
  inDir((dir) => {
    const f = join(dir, 'f.cc');
    const g = join(dir, 'g.cc');
    writeFileSync(f, 'a');
    writeFileSync(g, 'a');
    assert.equal(replacesFile(f, f), true);
    assert.equal(replacesFile(join(dir, '.', 'f.cc'), f), true);
    assert.equal(replacesFile(g, f), false, 'the same content is not the same file');
    assert.equal(replacesFile(join(dir, 'nope.cc'), f), false);
  });
});

test('replacesFile: a symlink leads to the file it points to — that is what gets written', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlinks need privileges on Windows');
    return;
  }
  inDir((dir) => {
    const f = join(dir, 'f.cc');
    const link = join(dir, 'link.cc');
    writeFileSync(f, 'a');
    symlinkSync(f, link);
    assert.equal(replacesFile(link, f), true);
  });
});

test('replacesFile: a hard link is the same file — the side that asks', () => {
  inDir((dir) => {
    const f = join(dir, 'f.cc');
    const hard = join(dir, 'hard.cc');
    writeFileSync(f, 'a');
    linkSync(f, hard);
    assert.equal(replacesFile(hard, f), true);
  });
});

test('writeFileAtomic: the permission bits of the file it replaces are kept', (t) => {
  if (process.platform === 'win32') {
    t.skip('no permission bits to speak of on Windows');
    return;
  }
  inDir((dir) => {
    const script = join(dir, 'run.py');
    writeFileSync(script, 'old');
    chmodSync(script, 0o755);
    writeFileAtomic(script, 'new');
    assert.equal(readFileSync(script, 'utf8'), 'new');
    assert.equal(statSync(script).mode & 0o777, 0o755, 'still executable');
  });
});

test('writeFileAtomic: through a symlink the file is written and the link stays a link', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlinks need privileges on Windows');
    return;
  }
  inDir((dir) => {
    const real = join(dir, 'real.cc');
    const link = join(dir, 'link.cc');
    writeFileSync(real, 'old');
    symlinkSync('real.cc', link);
    writeFileAtomic(link, 'new');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(real, 'utf8'), 'new');

    const dangling = join(dir, 'to-be.cc');
    symlinkSync('made.cc', dangling);
    writeFileAtomic(dangling, 'fresh');
    assert.equal(readFileSync(join(dir, 'made.cc'), 'utf8'), 'fresh', 'a link to nothing yet: the file is created');
  });
});

test('pathWithin: inside, the root itself, outside — a name that merely starts with two dots is inside', () => {
  const root = mkdtempSync(join(tmpdir(), 'sir-within-'));
  try {
    assert.equal(pathWithin(root, join(root, 'a', 'b.c')), join('a', 'b.c'));
    assert.equal(pathWithin(root, root), '');
    assert.equal(pathWithin(root, join(root, '..hidden.c')), '..hidden.c');
    assert.equal(pathWithin(root, join(root, '..', 'x.c')), undefined);
    assert.equal(pathWithin(root, dirname(root)), undefined);
    assert.equal(targetFor(join(root, '..hidden.c.sirp'), join(root, '..hidden.c')), '..hidden.c');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
