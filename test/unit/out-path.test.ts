import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveOutPath } from '../../src/infra/out-path.ts';
import { ensureParent } from '../../src/infra/fs.ts';
import type { Project } from '../../src/infra/project.ts';
import { ConfigError, PathError } from '../../src/core/errors.ts';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sir-out-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'chromium_src', 'browser', 'core'), { recursive: true });
  writeFileSync(join(root, 'chromium_src', 'browser', 'core', 'apdate.cc'), 'void a(){}\n');
  return root;
}

const IN = (root: string): string => join(root, 'chromium_src', 'browser', 'core', 'apdate.cc');

test('without --out the patch lands next to its file', () => {
  const root = repo();
  try {
    const { path } = resolveOutPath({ inPath: IN(root), out: null });
    assert.equal(path, `${IN(root)}.sirp`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a plain --out: a directory receives the name, any other path is used as is', () => {
  const root = repo();
  try {
    assert.equal(
      resolveOutPath({ inPath: IN(root), out: join(root, 'patch.sirp') }).path,
      join(root, 'patch.sirp'),
    );
    assert.equal(
      resolveOutPath({ inPath: IN(root), out: `${join(root, 'flat')}/` }).path,
      join(root, 'flat', 'apdate.cc.sirp'),
    );
    mkdirSync(join(root, 'existing'));
    assert.equal(
      resolveOutPath({ inPath: IN(root), out: join(root, 'existing') }).path,
      join(root, 'existing', 'apdate.cc.sirp'),
    );
    assert.equal(resolveOutPath({ inPath: IN(root), out: '-' }).path, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a relative --out is measured from the repository root', () => {
  const root = repo();
  const cwd = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.equal(
      resolveOutPath({ inPath: IN(root), out: 'out/' }).path,
      join(root, 'out', 'apdate.cc.sirp'),
    );
    assert.equal(resolveOutPath({ inPath: IN(root), out: 'out/one.sirp' }).path, join(root, 'out', 'one.sirp'));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a repository a relative --out falls back to the input file, never to cwd', () => {
  const loose = mkdtempSync(join(tmpdir(), 'sir-loose-'));
  const cwd = process.cwd();
  try {
    mkdirSync(join(loose, 'src'));
    writeFileSync(join(loose, 'src', 'a.cc'), 'void a(){}\n');
    process.chdir(tmpdir());
    assert.equal(
      resolveOutPath({ inPath: join(loose, 'src', 'a.cc'), out: 'out/' }).path,
      join(loose, 'src', 'out', 'a.cc.sirp'),
    );
  } finally {
    process.chdir(cwd);
    rmSync(loose, { recursive: true, force: true });
  }
});

test('the suffix is the caller\'s: apply writes a source file, generate a .sirp', () => {
  const root = repo();
  try {
    assert.equal(
      resolveOutPath({ inPath: IN(root), out: 'out/', suffix: '' }).path,
      join(root, 'out', 'apdate.cc'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── with an upstream (infra/project.ts) ──────────────────────────────────────────

/** A project whose config is at `configDir`, patching the code under `upstreamRoot`. */
function project(configDir: string, upstreamRoot: string): Project {
  return { configFile: join(configDir, 'sir.config.json'), projectRoot: configDir, upstreamRoot };
}

test('upstream: the tree under <config dir>/<out> repeats the path from the upstream root', () => {
  const root = repo();
  const cwd = process.cwd();
  try {
    process.chdir(tmpdir());
    // "upstream": "." — the one-repository tree that generate.mirror used to give
    const one = resolveOutPath({ inPath: IN(root), out: 'patches', project: project(root, root) });
    assert.equal(one.path, join(root, 'patches', 'chromium_src', 'browser', 'core', 'apdate.cc.sirp'));
    assert.equal(one.target, 'chromium_src/browser/core/apdate.cc');
    // Brave: the config in a subdirectory, the upstream its parent
    const brave = join(root, 'brave');
    mkdirSync(brave);
    const inside = resolveOutPath({ inPath: IN(root), out: 'patches', project: project(brave, root) });
    assert.equal(inside.path, join(brave, 'patches', 'chromium_src', 'browser', 'core', 'apdate.cc.sirp'));
    // an absolute out receives the same tail; a .sirp named outright is that file
    const elsewhere = join(tmpdir(), 'sir-out-abs');
    assert.equal(
      resolveOutPath({ inPath: IN(root), out: elsewhere, project: project(brave, root) }).path,
      join(elsewhere, 'chromium_src', 'browser', 'core', 'apdate.cc.sirp'),
    );
    assert.equal(resolveOutPath({ inPath: IN(root), out: 'one.sirp', project: project(brave, root) }).path, join(brave, 'one.sirp'));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('upstream: no tree without a directory, and no patch for a file outside the upstream', () => {
  const root = repo();
  try {
    const p = project(root, join(root, 'chromium_src'));
    assert.throws(() => resolveOutPath({ inPath: IN(root), out: null, project: p }), ConfigError);
    assert.throws(() => resolveOutPath({ inPath: IN(root), out: '-', project: p }), ConfigError);
    writeFileSync(join(root, 'top.cc'), 'void a(){}\n');
    assert.throws(
      () => resolveOutPath({ inPath: join(root, 'top.cc'), out: 'patches', project: p }),
      (e: unknown) => e instanceof ConfigError && /outside upstream/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--out naming a file that is not .sirp is refused', () => {
  const root = repo();
  try {
    assert.throws(() => resolveOutPath({ inPath: IN(root), out: 'p.md' }), /a patch is a \.sirp file/);
    assert.equal(resolveOutPath({ inPath: IN(root), out: 'p.md', suffix: '' }).path, join(root, 'p.md'), 'apply writes code');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a name without an extension is a directory, one with an extension is a file', () => {
  const root = repo();
  try {
    assert.equal(
      resolveOutPath({ inPath: IN(root), out: 'patches' }).path,
      join(root, 'patches', 'apdate.cc.sirp'),
      'patches is a directory, not a file called that',
    );
    assert.equal(resolveOutPath({ inPath: IN(root), out: 'one.sirp' }).path, join(root, 'one.sirp'));
    assert.equal(resolveOutPath({ inPath: IN(root), out: 'deep/one.sirp' }).path, join(root, 'deep', 'one.sirp'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file sitting where a directory is needed is named, not reported as EEXIST', () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'patches'), 'x');
    assert.throws(
      () => ensureParent(join(root, 'patches', 'chromium_src', 'a.cc.sirp')),
      (e: unknown) =>
        e instanceof PathError &&
        e.exitCode === 1 &&
        e.blocker === join(root, 'patches') &&
        /is a file/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureParent creates the whole chain when nothing blocks it', () => {
  const root = repo();
  try {
    ensureParent(join(root, 'a', 'b', 'c', 'x.sirp'));
    assert.ok(statSync(join(root, 'a', 'b', 'c')).isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
