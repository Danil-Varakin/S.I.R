// Builds `sir-apply` — one executable with Node, the tree-sitter runtime and every
// pinned grammar inside — for the platform this runs on (a release builds it on each:
// .github/workflows/release.yml). Node's single executable applications:
// https://nodejs.org/api/single-executable-applications.html
//
//   node scripts/build-apply-bin.mjs            → build/sir-apply-<version>-<os>-<arch>[.exe]
//
// 1. esbuild bundles src/bin/sir-apply.ts into one CommonJS file. `import.meta` does not
//    exist there: its `url` and `dirname` are defined from the executable's own path (the
//    tree-sitter runtime reads `import.meta.url` to find files it is handed as assets
//    instead), and the version is defined as a constant — there is no package.json.
// 2. The blob: the bundle plus its assets — web-tree-sitter.wasm and grammars/*.wasm,
//    fetched first by scripts/fetch-grammars.ts and checked against their pins.
// 3. A copy of this `node`, the blob injected with postject; on macOS signed ad hoc.

import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const os = { darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform];
if (os === undefined) throw new Error(`no sir-apply for ${process.platform}`);
const name = `sir-apply-${version}-${os}-${process.arch}${os === 'win' ? '.exe' : ''}`;

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. the bundle
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'bin', 'sir-apply.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  outfile: join(OUT, 'sir-apply.cjs'),
  banner: {
    js:
      "const __sirUrl = require('node:url').pathToFileURL(process.execPath).href;\n" +
      "const __sirDirname = require('node:path').dirname(process.execPath);",
  },
  define: {
    'import.meta.url': '__sirUrl',
    'import.meta.dirname': '__sirDirname',
    __SIR_VERSION__: JSON.stringify(version),
  },
  logLevel: 'warning',
});

// 2. the blob, with its assets
run(process.execPath, ['--experimental-strip-types', join(ROOT, 'scripts', 'fetch-grammars.ts')]);
const assets = { 'web-tree-sitter.wasm': join(ROOT, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm') };
for (const file of readdirSync(join(ROOT, 'grammars'))) {
  if (file.endsWith('.wasm')) assets[file] = join(ROOT, 'grammars', file);
}
const seaConfig = join(OUT, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: join(OUT, 'sir-apply.cjs'),
    output: join(OUT, 'sir-apply.blob'),
    disableExperimentalSEAWarning: true,
    // a code cache is tied to the V8 it was made by: every platform builds its own
    useCodeCache: true,
    assets,
  }),
);
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. the executable
const exe = join(OUT, name);
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (os === 'darwin') run('codesign', ['--remove-signature', exe]);
run(process.execPath, [
  join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
  exe,
  'NODE_SEA_BLOB',
  join(OUT, 'sir-apply.blob'),
  '--sentinel-fuse',
  FUSE,
  ...(os === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (os === 'darwin') run('codesign', ['--sign', '-', exe]);

process.stdout.write(`${exe}\n`);
