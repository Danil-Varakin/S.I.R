import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { adapterOf, driftCases, patchOf } from '../matrix.ts';
import type { Fixture } from '../matrix.ts';
import { applyAll } from '../../src/core/apply.ts';

// docs/10-brave-languages.md, 7.11: the drift of the matrix, through sir and through
// `git apply` — a unified diff with three lines of context, the form a fork keeps its
// patches in today. Per row: in how many languages each lands right. sir must never
// land wrong; a row where `git apply` lands and sir does not is a regression to see.

const UNIT = import.meta.dirname;

async function fixtures(): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (const dir of readdirSync(UNIT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const file = join(UNIT, dir.name, `${dir.name}-fixture.ts`);
    try {
      readFileSync(file);
    } catch {
      continue;
    }
    out.push(((await import(pathToFileURL(file).href)) as { fixture: Fixture }).fixture);
  }
  return out;
}

type Outcome = 'lands' | 'refuses' | 'WRONG';

function gitApply(dir: string, oldText: string, newText: string, base: string, expected: string): Outcome {
  writeFileSync(join(dir, 'old'), oldText);
  writeFileSync(join(dir, 'new'), newText);
  let diff: string;
  try {
    diff = execFileSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '-U3', 'old', 'new'], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    diff = (e as { stdout: string }).stdout; // exit 1: the files differ
  }
  diff = diff.replace(/^(---|\+\+\+) [ab]\/(old|new)$/gm, (_, side: string) => `${side} ${side === '---' ? 'a' : 'b'}/f`)
    .replace(/^diff --git a\/old b\/new$/m, 'diff --git a/f b/f');
  writeFileSync(join(dir, 'p.diff'), diff);
  writeFileSync(join(dir, 'f'), base);
  try {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', 'p.diff'], { cwd: dir, stdio: 'pipe' });
  } catch {
    return 'refuses';
  }
  return readFileSync(join(dir, 'f'), 'utf8') === expected ? 'lands' : 'WRONG';
}

test('7.11: the drift of the matrix through sir and through git apply', async (t) => {
  if (process.platform === 'win32') {
    // git for Windows reads and writes the files of `git apply` by its own line-ending
    // settings: the git column is measured where git keeps bytes as they are
    t.skip('the git column is measured on POSIX');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sir-vs-git-'));
  const table = new Map<string, { git: number; sir: number; languages: number; gitOnly: string[] }>();
  try {
    for (const f of await fixtures()) {
      const a = await adapterOf(f.language);
      for (const c of driftCases(f)) {
        let sir: Outcome;
        try {
          sir = applyAll(c.base, patchOf(c.oldText, c.newText, a), a).source === c.expected ? 'lands' : 'WRONG';
        } catch {
          sir = 'refuses';
        }
        const git = gitApply(dir, c.oldText, c.newText, c.base, c.expected);
        assert.notEqual(sir, 'WRONG', `${f.language} ${c.row}: sir landed wrong`);
        const row = table.get(c.row) ?? { git: 0, sir: 0, languages: 0, gitOnly: [] };
        row.languages++;
        if (git === 'lands') row.git++;
        if (sir === 'lands') row.sir++;
        if (git === 'lands' && sir !== 'lands') row.gitOnly.push(f.language);
        table.set(c.row, row);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const got = Object.fromEntries([...table].map(([row, r]) => [row, `git ${r.git}/${r.languages} · sir ${r.sir}/${r.languages}${r.gitOnly.length ? ` · только git: ${r.gitOnly.join(', ')}` : ''}`]));
  if (process.env['SIR_PRINT'] === '1') console.log(got);
  assert.deepEqual(got, EXPECTED);
});

// sir is behind `git apply` in one row — Н1 (07-findings): when the author decides Р6,
// this line changes with it
const EXPECTED: Record<string, string> = {
  'К0 без дрейфа': 'git 23/23 · sir 23/23',
  'К1в вставка, дрейф далеко от правки': 'git 23/23 · sir 23/23',
  'К1 вставка, дрейф': 'git 3/23 · sir 23/23',
  'К1 замена, дрейф': 'git 3/23 · sir 23/23',
  'К2 замена, внешний блок переименован': 'git 23/23 · sir 23/23',
  'К2 вставка, внешний блок переименован': 'git 23/23 · sir 4/23 · только git: c, cpp, css, go, html, idl, java, javascript, json, json5, kotlin, mojom, proto, python, rust, shell, tsx, typescript, xml',
  'К4 CRLF': 'git 0/23 · sir 23/23',
  'К5 BOM': 'git 3/23 · sir 23/23',
  'К9 20 ханков, дрейф': 'git 3/23 · sir 23/23',
  'К3 комментарий над якорем': 'git 0/23 · sir 23/23',
  'К1б строка upstream прямо над правкой': 'git 0/23 · sir 23/23',
};
