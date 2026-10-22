// Every apply golden through a `sir-apply` binary: the result must be the expected
// file, byte for byte — the same engine as the package, in one executable (VERSIONING.md
// F3). Run by CI and by the release on every platform it builds for.
//
//   node test/golden/run-binary.mjs build/sir-apply-<version>-<os>-<arch>

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = process.argv[2];
if (binary === undefined) {
  process.stderr.write('usage: node test/golden/run-binary.mjs <sir-apply>\n');
  process.exit(1);
}
const HERE = fileURLToPath(new URL('.', import.meta.url));

let passed = 0;
const failures = [];
for (const language of readdirSync(HERE).sort()) {
  const dir = join(HERE, language, 'apply');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir);
  for (const patch of files.filter((f) => /^test\d+\.sirp$/.test(f))) {
    const n = patch.slice(0, -'.sirp'.length);
    const source = files.find((f) => f.startsWith(`${n}.`) && !f.endsWith('.sirp') && !f.startsWith(`${n}.expected.`));
    if (source === undefined) {
      failures.push(`${language}/apply/${n}: no source beside ${patch}`);
      continue;
    }
    const text = readFileSync(join(dir, source), 'utf8');
    // the line a golden describes itself in: the first, the second after a `#!` line
    const [first = '', second = ''] = text.split('\n', 2);
    const mustRefuse = (first.startsWith('#!') ? second : first).includes('MUST-REFUSE');
    const r = spawnSync(
      resolve(binary),
      ['apply', '--match', patch, '--in', source, '--out', '-', '--base-from-disk', '--no-config'],
      { cwd: dir, encoding: 'utf8' },
    );
    const name = `${language}/apply/${n}`;
    if (mustRefuse) {
      // refused as a patch is refused — 3 no match, 4 ambiguous; a crash is no refusal
      if (r.status === 0) failures.push(`${name}: applied, and it must not`);
      else if (r.status !== 3 && r.status !== 4) failures.push(`${name}: exit ${r.status}, not a refusal (3 or 4)\n${r.stderr}`);
      else passed++;
      continue;
    }
    const expected = readFileSync(join(dir, `${n}.expected${extname(source)}`), 'utf8');
    if (r.status !== 0) failures.push(`${name}: exit ${r.status}\n${r.stderr}`);
    else if (r.stdout !== expected) failures.push(`${name}: the result differs from ${n}.expected${extname(source)}`);
    else passed++;
  }
}
process.stdout.write(`sir-apply goldens: ${passed} passed, ${failures.length} failed\n`);
for (const f of failures) process.stderr.write(`  ${f}\n`);
process.exitCode = failures.length === 0 && passed > 0 ? 0 : 1;
