// The package as a user gets it: `npm pack`, then the archive installed the way README
// says — `npm i -g <hatch-<version>.tgz>` — into a prefix of its own, and used from there
// with nothing of this checkout on the path: the `hatch` command (version, generate,
// apply, both grammars of different families), the API through `import('hatch')`, the
// `hatch/protocol` and `hatch/service` entry points, a closed sub-path, and the service
// the editor starts. Run by CI; slow (it packs and installs), so not part of `npm test`.
//
//   node test/install-smoke.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = mkdtempSync(join(tmpdir(), 'hatch-install-'));
const failures = [];

function check(name, ok, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  if (!ok) failures.push(`${name}${detail ? `\n${detail}` : ''}`);
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

try {
  // ── pack: prepack fetches the grammars and builds dist/ ───────────────────────────
  execFileSync(npm, ['pack', '--pack-destination', work], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  const tgz = readdirSync(work).find((f) => f === `hatch-${version}.tgz`);
  check(`npm pack writes hatch-${version}.tgz, the name README installs`, tgz !== undefined, readdirSync(work).join(', '));
  if (tgz === undefined) throw new Error('no archive');

  // ── install globally, into a prefix of our own ────────────────────────────────────
  const prefix = join(work, 'global');
  const install = run(npm, ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', join(work, tgz)]);
  check('npm i -g <archive> installs', install.status === 0, install.stderr);
  const bin = process.platform === 'win32' ? join(prefix, 'hatch.cmd') : join(prefix, 'bin', 'hatch');
  const pkgDir = process.platform === 'win32' ? join(prefix, 'node_modules', 'hatch') : join(prefix, 'lib', 'node_modules', 'hatch');

  // ── the command, from a directory that knows nothing of this checkout ─────────────
  const project = join(work, 'project');
  execFileSync('git', ['init', '-q', project]);
  const hatch = (...args) => run(bin, args, { cwd: project });

  const v = hatch('--version');
  check('hatch --version names this version and the config schema', v.status === 0 && v.stdout.includes(version) && /config schema/.test(v.stdout), v.stdout + v.stderr);

  for (const [name, oldText, newText] of [
    ['a.cc', 'void f() {\n  a();\n}\n', 'void f() {\n  a();\n  b();\n}\n'],
    ['a.py', 'def f():\n    a()\n', 'def f():\n    a()\n    b()\n'],
  ]) {
    writeFileSync(join(project, `old-${name}`), oldText);
    writeFileSync(join(project, name), newText);
    const gen = hatch('generate', '--no-config', '--in', name, '--in-old', `old-${name}`, '--out', `${name}.hatch`);
    check(`hatch generate ${name}: the grammar ships inside, nothing is fetched`, gen.status === 0, gen.stderr);
    const apply = hatch('apply', '--no-config', '--match', `${name}.hatch`, '--in', `old-${name}`, '--out', `out-${name}`);
    const out = apply.status === 0 ? readFileSync(join(project, `out-${name}`), 'utf8') : '';
    check(`hatch apply ${name}: the generated patch gives the new file`, out === newText, apply.stderr);
  }

  // ── the API, imported as a dependent imports it ───────────────────────────────────
  const consumer = join(work, 'consumer');
  execFileSync('git', ['init', '-q', consumer]);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module', private: true }));
  const local = run(npm, ['install', '--no-audit', '--no-fund', join(work, tgz)], { cwd: consumer });
  check('npm i <archive> as a dependency', local.status === 0, local.stderr);
  writeFileSync(
    join(consumer, 'use.mjs'),
    `import { applyAll, synthesize, parseHatchFile, printHatchFile, adapterForLanguage, HatchError } from 'hatch';
import { PROTOCOL_VERSION } from 'hatch/protocol';
import { serve } from 'hatch/service';
const adapter = adapterForLanguage('cpp');
await adapter.init();
const oldCode = 'void f() {\\n  a();\\n}\\n';
const newCode = 'void f() {\\n  a();\\n  b();\\n}\\n';
const md = printHatchFile(synthesize(oldCode, newCode, adapter), 'cpp');
const { source } = applyAll(oldCode, parseHatchFile(md), adapter);
if (source !== newCode) throw new Error('the README example does not round-trip');
if (typeof serve !== 'function' || typeof PROTOCOL_VERSION !== 'number' || typeof HatchError !== 'function') throw new Error('an entry point is missing');
let closed = false;
try { await import('hatch/dist/core/matcher.js'); } catch (e) { closed = e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
if (!closed) throw new Error('a sub-path is open');
console.log('api ok');
`,
  );
  const api = run(process.execPath, ['use.mjs'], { cwd: consumer, shell: false });
  check("import('hatch'), 'hatch/protocol', 'hatch/service'; sub-paths closed", api.status === 0 && api.stdout.includes('api ok'), api.stdout + api.stderr);

  // ── the service, started the way the extension starts it ──────────────────────────
  const service = run(process.execPath, [join(pkgDir, 'dist', 'bin', 'service.js')], {
    input: `${JSON.stringify({ id: 1, method: 'version' })}\n`,
    shell: false,
  });
  let reply = {};
  try {
    reply = JSON.parse(service.stdout.trim());
  } catch {}
  check('the service answers version over stdio, with this version', reply.ok === true && reply.result?.hatch === version && Number.isInteger(reply.result?.protocol), service.stdout + service.stderr);
} catch (e) {
  failures.push(String(e?.stack ?? e));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} failure(s):\n${failures.join('\n\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nthe installed package works\n');
