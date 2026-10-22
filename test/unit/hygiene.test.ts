import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// test/golden/** is DATA: its bytes are what the tests are about (see .gitattributes).
const SKIP = new Set([join(ROOT, 'test', 'golden')]);

function sources(dir: string, out: string[] = []): string[] {
  if (SKIP.has(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const FILES = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'test')), ...sources(join(ROOT, 'bench'))];

test('sources carry no trailing whitespace', () => {
  const offenders: string[] = [];
  for (const path of FILES) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/[ \t]+$/.test(line)) offenders.push(`${relative(ROOT, path)}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, [], `trailing whitespace in ${offenders.length} line(s)`);
});

test('sources are LF-only and end with exactly one newline', () => {
  const offenders: string[] = [];
  for (const path of FILES) {
    const text = readFileSync(path, 'utf8');
    const name = relative(ROOT, path);
    if (text.includes('\r')) offenders.push(`${name}: contains CR`);
    if (text !== '' && !text.endsWith('\n')) offenders.push(`${name}: no newline at end of file`);
    if (text.endsWith('\n\n')) offenders.push(`${name}: blank line at end of file`);
  }
  assert.deepEqual(offenders, []);
});

test('sources indent with spaces, never tabs', () => {
  const offenders: string[] = [];
  for (const path of FILES) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^[ ]*\t/.test(line)) offenders.push(`${relative(ROOT, path)}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, []);
});
