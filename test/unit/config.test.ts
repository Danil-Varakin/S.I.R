import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  DEFAULT_SETTINGS,
  basesOnGit,
  configCandidates,
  findConfigFile,
  formatConfig,
  knownConfigKeys,
  loadConfig,
  readConfigFile,
  resolveConfig,
} from '../../src/infra/config/index.ts';
import { ConfigError, SynthesisError } from '../../src/core/errors.ts';
import { DEFAULT_SYNTH_LIMITS, resolveLimits, synthesize } from '../../src/generate/synth.ts';
import { printSirFile } from '../../src/generate/printer.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { buildRepo, version } from '../git-repo.ts';

function withTempDir(body: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sir-cfg-'));
    try {
      await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function withHome(dir: string, body: () => void): void {
  const keys = ['HOME', 'USERPROFILE'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of keys) process.env[k] = dir;
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function writeConfig(dir: string, body: unknown): string {
  const file = join(dir, CONFIG_FILE_NAME);
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

test('no file and no flags: built-in defaults, every origin is "default"', () => {
  const config = resolveConfig({});
  assert.deepEqual({ ...config.generate }, { ...DEFAULT_SETTINGS });
  assert.equal(config.file, undefined);
  for (const key of knownConfigKeys()) assert.equal(config.origins[key], 'default');
});

test('file overrides defaults, flag overrides file', () => {
  const config = resolveConfig({
    file: '/repo/sir.config.json',
    fromFile: { maxSiblings: 1, minParents: 2, out: 'patches/' },
    flags: [{ key: 'maxSiblings', value: 0, flag: '--siblings' }],
  });
  assert.equal(config.generate.maxSiblings, 0);
  assert.equal(config.origins['generate.siblings.max'], 'flag --siblings');
  assert.equal(config.generate.minParents, 2);
  assert.equal(config.origins['generate.parents.min'], 'config /repo/sir.config.json');
  assert.equal(config.generate.parentDetailBase, DEFAULT_SETTINGS.parentDetailBase);
  assert.equal(config.origins['generate.parents.detail.base'], 'default');
});

test('undefined values do not wipe the layer below', () => {
  const config = resolveConfig({
    fromFile: { maxSiblings: undefined, minParents: 3 },
    flags: [{ key: 'minParents', value: undefined, flag: '--min-parents' }],
  });
  assert.equal(config.generate.maxSiblings, DEFAULT_SETTINGS.maxSiblings);
  assert.equal(config.generate.minParents, 3);
});

test('a flag value is validated as strictly as a file value', () => {
  assert.throws(
    () => resolveConfig({ flags: [{ key: 'maxSiblings', value: 'x', flag: '--siblings' }] }),
    (e: unknown) => e instanceof ConfigError && e.exitCode === 5 && /non-negative integer/.test(e.message),
  );
});

test('parents.max accepts "all" and refuses null', () => {
  const all = resolveConfig({ flags: [{ key: 'maxParents', value: 'all', flag: '--parents' }] });
  assert.equal(all.generate.maxParents, 'all');
  assert.throws(() => resolveConfig({ flags: [{ key: 'maxParents', value: null, flag: '--parents' }] }), ConfigError);
});

test('resolveLimits takes only defined keys', () => {
  assert.deepEqual({ ...resolveLimits(undefined) }, { ...DEFAULT_SYNTH_LIMITS });
  const limits = resolveLimits({ maxSiblings: 0, minParents: undefined });
  assert.equal(limits.maxSiblings, 0);
  assert.equal(limits.minParents, DEFAULT_SYNTH_LIMITS.minParents);
});

test('a detail ceiling is no longer a key at all', withTempDir((dir) => {
  const file = writeConfig(dir, { version: 3, generate: { parents: { detail: { limit: 2 } } } });
  assert.throws(
    () => readConfigFile(file),
    (e: unknown) => e instanceof ConfigError && /unknown key "generate\.parents\.detail\.limit"/.test(e.message),
  );
}));

test('a minimum above its maximum is a wish, not a contradiction: the config keeps it, synthesis clamps it', () => {
  assert.equal(
    resolveConfig({
      flags: [
        { key: 'minSiblings', value: 5, flag: '--min-siblings' },
        { key: 'maxSiblings', value: 2, flag: '--siblings' },
      ],
    }).generate.minSiblings,
    5,
  );
});

test('an unknown key is an error, not a silent default', withTempDir((dir) => {
  const file = writeConfig(dir, { version: 3, generate: { siblings: { maxx: 3 } } });
  assert.throws(
    () => readConfigFile(file),
    (e: unknown) =>
      e instanceof ConfigError &&
      /unknown key "generate\.siblings\.maxx"/.test(e.message) &&
      /known keys/.test(e.message),
  );
}));

test('an unknown top-level key is caught too', withTempDir((dir) => {
  assert.throws(() => readConfigFile(writeConfig(dir, { version: 3, apply: { out: 'x' } })), (e: unknown) => e instanceof ConfigError && /"apply"/.test(e.message));
}));

test('wrong types and out-of-range numbers are refused', withTempDir((dir) => {
  const names = (key: RegExp) => (e: unknown): boolean => e instanceof ConfigError && key.test(e.message);
  assert.throws(() => readConfigFile(writeConfig(dir, { generate: { exact: 'yes' } })), names(/generate\.exact/));
  assert.throws(() => readConfigFile(writeConfig(dir, { generate: { siblings: { max: -1 } } })), names(/generate\.siblings\.max/));
  assert.throws(() => readConfigFile(writeConfig(dir, { generate: { siblings: { max: 1.5 } } })), names(/generate\.siblings\.max/));
  assert.throws(() => readConfigFile(writeConfig(dir, { generate: { out: '' } })), names(/generate\.out/));
  assert.throws(() => readConfigFile(writeConfig(dir, { generate: 5 })), names(/"generate"/));
}));

test('README "Configuration": JSON with no comments and no trailing commas — either is refused', withTempDir((dir) => {
  assert.throws(() => readConfigFile(writeConfig(dir, '{ "version": 3 // the schema\n}')), /invalid JSON/);
  assert.throws(() => readConfigFile(writeConfig(dir, '{ "version": 3, }')), /invalid JSON/);
}));

test('broken JSON and a bad version value are refused', withTempDir((dir) => {
  assert.throws(() => readConfigFile(writeConfig(dir, '{ nope')), /invalid JSON/);
  assert.throws(() => readConfigFile(writeConfig(dir, { version: 'two' })), /"version" must be/);
}));

test('$schema is ignored, "all" and booleans pass through', withTempDir((dir) => {
  const file = writeConfig(dir, {
    $schema: './sir.config.schema.json',
    version: 3,
    generate: { parents: { max: 'all', required: true } },
  });
  assert.deepEqual(readConfigFile(file), { maxParents: 'all', parentsRequired: true });
}));

test('a version other than the current one is refused', withTempDir((dir) => {
  const file = writeConfig(dir, { version: CONFIG_VERSION + 1, generate: {} });
  assert.throws(() => readConfigFile(file), /does not know yet — it reads v3: update sir/);
}));

test('the config is searched for UPWARDS from the input file', withTempDir((dir) => {
  const file = writeConfig(dir, { version: 3, generate: { siblings: { max: 1 } } });
  const deep = join(dir, 'src', 'net');
  mkdirSync(deep, { recursive: true });
  assert.equal(findConfigFile(deep), file);

  const config = loadConfig({ startDir: deep, useFile: true });
  assert.equal(config.generate.maxSiblings, 1);
  assert.equal(config.file, file);
}));

test('the search STOPS at the repository root', withTempDir((dir) => {
  const above = writeConfig(dir, { version: 3, generate: { siblings: { max: 1 } } });
  const repo = join(dir, 'repo');
  const deep = join(repo, 'src', 'net');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(deep, { recursive: true });

  assert.equal(findConfigFile(deep), undefined);
  const bounded = loadConfig({ startDir: deep, useFile: true });
  assert.equal(bounded.generate.maxSiblings, DEFAULT_SETTINGS.maxSiblings);
  assert.equal(bounded.file, undefined);

  const own = writeConfig(repo, { version: 3, generate: { siblings: { max: 2 } } });
  assert.equal(findConfigFile(deep), own);

  assert.equal(loadConfig({ startDir: deep, useFile: true, explicitPath: above }).generate.maxSiblings, 1);
}));

test('a .git FILE ends the project too (worktree, submodule)', withTempDir((dir) => {
  writeConfig(dir, { version: 3, generate: { siblings: { max: 1 } } });
  const repo = join(dir, 'linked');
  const deep = join(repo, 'src');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');

  assert.equal(findConfigFile(deep), undefined);
}));

test('a config in the HOME directory is not inherited by projects below it', withTempDir((dir) => {
  const forgotten = writeConfig(dir, { version: 3, generate: { siblings: { max: 1 } } });
  const deep = join(dir, 'projects', 'app');
  mkdirSync(deep, { recursive: true });

  withHome(dir, () => {
    assert.equal(findConfigFile(deep), undefined);
    assert.equal(findConfigFile(dir), forgotten);
  });
}));

test('from the HOME directory itself the search looks there and goes no higher', withTempDir((dir) => {
  const home = join(dir, 'home');
  mkdirSync(home);
  writeConfig(dir, { version: 3 });
  withHome(home, () => {
    assert.deepEqual(configCandidates(home), [join(home, CONFIG_FILE_NAME)]);
    assert.equal(findConfigFile(home), undefined);
  });
}));

test('--no-config ignores the file, --config demands an existing one', withTempDir((dir) => {
  writeConfig(dir, { version: 3, generate: { siblings: { max: 1 } } });
  const off = loadConfig({ startDir: dir, useFile: false });
  assert.equal(off.generate.maxSiblings, DEFAULT_SETTINGS.maxSiblings);
  assert.equal(off.file, undefined);

  assert.throws(
    () => loadConfig({ startDir: dir, useFile: true, explicitPath: join(dir, 'nope.json') }),
    (e: unknown) => e instanceof ConfigError && /no such config file/.test(e.message),
  );
}));

test('formatConfig prints every value with its origin', () => {
  const text = formatConfig(resolveConfig({ flags: [{ key: 'maxSiblings', value: 0, flag: '--siblings' }] }));
  assert.match(text, new RegExp(`^version = ${CONFIG_VERSION}$`, 'm'));
  assert.match(text, /generate\.siblings\.max\s+= 0\s+\[flag --siblings\]/);
  assert.match(text, /generate\.parents\.min\s+= 1\s+\[default\]/);
});

test('schema 3: generate.base names the old version in git; schemas 1 and 2 are read no longer (C3)', withTempDir((dir) => {
  const file = writeConfig(dir, { version: 3, generate: { base: { branch: 'main', commit: 'v1.0' } } });
  assert.deepEqual(readConfigFile(file), { baseBranch: 'main', baseCommit: 'v1.0' });
  const config = loadConfig({ startDir: dir, useFile: true });
  assert.equal(basesOnGit(config.generate), true);
  assert.equal(basesOnGit(DEFAULT_SETTINGS), false);

  for (const version of [1, 2]) {
    const old = writeConfig(dir, { version, generate: { base: { head: true } } });
    assert.throws(
      () => readConfigFile(old),
      new RegExp(`"version" ${version} is a config schema this sir no longer reads — it reads v3: move the file to v3`),
    );
  }
}));

test('the JSON Schema lists exactly the keys the code knows', () => {
  const schemaPath = fileURLToPath(new URL('../../sir.config.schema.json', import.meta.url));
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, never>;
  const paths: string[] = [];
  const walk = (node: Record<string, never>, prefix: string): void => {
    for (const [key, value] of Object.entries(node['properties'] ?? {})) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const child = value as Record<string, never>;
      if (child['properties'] !== undefined) walk(child, path);
      else if (path !== '$schema' && path !== 'version') paths.push(path);
    }
  };
  walk(schema, '');
  assert.deepEqual(paths.sort(), knownConfigKeys().sort());
});

const NESTED_OLD = 'namespace net {\nvoid f() {\n  int a = 1;\n  g(a);\n}\n}\n';
const NESTED_NEW = 'namespace net {\nvoid f() {\n  int a = 2;\n  g(a);\n}\n}\n';

test('parents.min: the ladder starts at the requested number of parents', async () => {
  await cppAdapter.init();
  const one = printSirFile(synthesize(NESTED_OLD, NESTED_NEW, cppAdapter), 'cpp');
  assert.ok(!one.includes('namespace net {'), one);

  const two = printSirFile(synthesize(NESTED_OLD, NESTED_NEW, cppAdapter, { limits: { minParents: 2 } }), 'cpp');
  assert.ok(two.includes('namespace net {'), two);
  assert.ok(two.includes('void f() {'), two);
});

test('parents.max caps the climb, and asking for more than the file has is fine', async () => {
  await cppAdapter.init();
  const capped = printSirFile(
    synthesize(NESTED_OLD, NESTED_NEW, cppAdapter, { limits: { minParents: 5, maxParents: 1 } }),
    'cpp',
  );
  assert.ok(!capped.includes('namespace net {'), capped);
});

test('siblings.max = 0: ambiguity is resolved by structure, not by a neighbour', async () => {
  await cppAdapter.init();
  const oldStr = 'void f() {\n  x = 1;\n  y();\n  x = 1;\n}\n';
  const newStr = 'void f() {\n  x = 2;\n  y();\n  x = 1;\n}\n';
  const withNeighbours = printSirFile(synthesize(oldStr, newStr, cppAdapter), 'cpp');
  assert.ok(withNeighbours.includes('y();'), withNeighbours);

  const structural = printSirFile(synthesize(oldStr, newStr, cppAdapter, { limits: { maxSiblings: 0 } }), 'cpp');
  assert.ok(!structural.includes('y();'), structural);
  assert.ok(structural.includes('void f() {'), structural);
});

test('siblings.max = 0: an edit only a neighbour could pin is refused, not guessed', async () => {
  await cppAdapter.init();
  const oldStr = 'void f() {\n  a();\n  b();\n}\n';
  const newStr = 'void f() {\n  a();\n  x();\n  b();\n}\n';
  assert.ok(printSirFile(synthesize(oldStr, newStr, cppAdapter), 'cpp').includes('a();'));
  assert.throws(
    () => synthesize(oldStr, newStr, cppAdapter, { limits: { maxSiblings: 0 } }),
    (e) => e instanceof SynthesisError && e.reason === 'no-match',
  );
});

test('detail.base: the baseline decides how much of a bracket stays spelled out', async () => {
  await cppAdapter.init();
  const oldStr = 'void f(map<int, A> m) {\n  x = 1;\n}\n';
  const newStr = 'void f(map<int, A> m) {\n  x = 2;\n}\n';

  const collapsed = printSirFile(synthesize(oldStr, newStr, cppAdapter), 'cpp');
  assert.ok(!collapsed.includes('map<'), collapsed);

  const readable = printSirFile(synthesize(oldStr, newStr, cppAdapter, { limits: { parentDetailBase: 1 } }), 'cpp');
  assert.ok(readable.includes('void f(map<'), readable);
  assert.ok(!readable.includes('<int, A>'), readable);

  const verbose = printSirFile(synthesize(oldStr, newStr, cppAdapter, { limits: { parentDetailBase: 2 } }), 'cpp');
  assert.ok(verbose.includes('void f(map<int, A> m) {'), verbose);
});

test('the round unfolds a neighbour bracket by itself when that is what tells them apart', async () => {
  await cppAdapter.init();
  const oldStr = 'void f() {\n  log(fmt(a, b));\n  x = 1;\n  log(fmt(c, d));\n  x = 1;\n}\n';
  const newStr = 'void f() {\n  log(fmt(a, b));\n  x = 1;\n  log(fmt(c, d));\n  x = 2;\n}\n';
  const md = printSirFile(synthesize(oldStr, newStr, cppAdapter), 'cpp');
  assert.ok(md.includes('log(fmt(c, d));'), md);
});

test('a bracket that discriminates nothing is NOT dragged along', async () => {
  await cppAdapter.init();
  const oldStr =
    'class W : public Base<Alpha> {\n  void Run(map<int, T> m) {\n    x = 1;\n  }\n};\n' +
    'class W : public Base<Beta> {\n  void Run(map<int, T> m) {\n    x = 1;\n  }\n};\n';
  const newStr = oldStr.replace('Base<Beta> {\n  void Run(map<int, T> m) {\n    x = 1;', 'Base<Beta> {\n  void Run(map<int, T> m) {\n    x = 2;');
  const md = printSirFile(synthesize(oldStr, newStr, cppAdapter), 'cpp');
  assert.ok(md.includes('Base<Beta>'), md);
  assert.ok(!md.includes('map<'), md);
});

const SIR_CLI = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('node', ['--experimental-strip-types', SIR_CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function seedSources(dir: string): void {
  writeFileSync(join(dir, 'old.cc'), NESTED_OLD);
  writeFileSync(join(dir, 'in.cc'), NESTED_NEW);
}

test('CLI: out and language come from the config, --print-config shows the origin', withTempDir((dir) => {
  seedSources(dir);
  mkdirSync(join(dir, 'patches'));
  writeConfig(dir, { version: 3, generate: { out: 'patches/', language: 'cpp', parents: { min: 2 } } });

  const printed = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc', '--print-config'], dir);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /generate\.out\s+= "patches\/"\s+\[config .*sir\.config\.json\]/);

  const gen = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc'], dir);
  assert.equal(gen.status, 0, gen.stderr);
  const md = readFileSync(join(dir, 'patches', 'in.cc.sirp'), 'utf8');
  assert.match(md, /^# match cpp$/m);
  assert.ok(md.includes('namespace net {'), md);
}));

test('CLI: a flag beats the config, --no-config drops the file', withTempDir((dir) => {
  seedSources(dir);
  writeConfig(dir, { version: 3, generate: { language: 'cpp', parents: { min: 2 } } });

  const flagWins = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc', '--min-parents', '1', '--out', '-'], dir);
  assert.equal(flagWins.status, 0, flagWins.stderr);
  assert.ok(!flagWins.stdout.includes('namespace net {'), flagWins.stdout);

  const printed = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc', '--no-config', '--print-config'], dir);
  assert.match(printed.stdout, /generate\.parents\.min\s+= 1\s+\[default\]/);
  assert.match(printed.stdout, /generate\.language\s+= null\s+\[default\]/);
}));

test('CLI: a broken config and a broken flag value both exit with 5', withTempDir((dir) => {
  seedSources(dir);
  writeConfig(dir, { version: 3, generate: { siblings: { max: -1 } } });
  const broken = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc', '--out', '-'], dir);
  assert.equal(broken.status, 5, broken.stderr);
  assert.match(broken.stderr, /ConfigError/);

  const badFlag = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc', '--no-config', '--siblings', 'x'], dir);
  assert.equal(badFlag.status, 5, badFlag.stderr);
}));

test('CLI: --parent-detail is honoured, and the removed ceiling flag is refused', withTempDir((dir) => {
  seedSources(dir);
  writeConfig(dir, { generate: { language: 'cpp', parents: { detail: { base: 0 } } } });
  const gen = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc', '--parent-detail', '1', '--out', '-'], dir);
  assert.equal(gen.status, 0, gen.stderr);
  assert.match(gen.stdout, /^# match cpp$/m);

  const stale = runCli(['generate', '--in', 'in.cc', '--in-old', 'old.cc', '--parent-detail-limit', '1', '--out', '-'], dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /--parent-detail-limit/);
}));

test('CLI generate: generate.base in the config is the old version when no flag names one', () => {
  const repo = buildRepo('sir-cfg-base-');
  try {
    writeFileSync(repo.inPath, version(4));
    writeFileSync(join(repo.dir, CONFIG_FILE_NAME), JSON.stringify({ version: 3, generate: { base: { commit: repo.a } } }));
    const gen = (...args: string[]): string => {
      const r = runCli(['generate', '--in', repo.inPath, '--out', '-', ...args], repo.dir);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.replace(/^Base-Blob: .*\n/m, '');
    };
    const against = (text: string): string => {
      const oldFile = join(repo.dir, 'old.cc');
      writeFileSync(oldFile, text);
      return gen('--in-old', oldFile);
    };

    assert.equal(gen(), against(version(1)), 'the commit the config names');
    assert.equal(gen('--branch', 'side'), against(version(3)), 'the branch the flag names');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
