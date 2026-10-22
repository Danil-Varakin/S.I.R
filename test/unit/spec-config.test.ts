import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CONFIG_FILE_NAME, DEFAULT_SETTINGS, loadConfig, readConfigFile } from '../../src/infra/config/index.ts';
import { ConfigError } from '../../src/core/errors.ts';

// Audit 2026-10-05: sir.config.json against README "Configuration" and VERSIONING.md
// C1/C5: "an unknown key is an error (exit 5), not a silent default"; a file is held to
// the schema version it names; `sir init` writes only "$schema" and "version", "so every
// default stays the built-in one".

function inDir(body: (dir: string) => void): () => void {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'sir-spec-cfg-'));
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const write = (dir: string, text: string): string => {
  const file = join(dir, CONFIG_FILE_NAME);
  writeFileSync(file, text);
  return file;
};

const refused = (file: string): void => {
  assert.throws(
    () => readConfigFile(file),
    (e: unknown) => e instanceof ConfigError && e.exitCode === 5,
    file,
  );
};

test('config: a file that is not a JSON object — empty, null, an array, a number — is a ConfigError (exit 5)', inDir((dir) => {
  for (const text of ['', '   \n', 'null', '[]', '[{"version":3}]', '2', '"version"']) {
    assert.throws(
      () => readConfigFile(write(dir, text)),
      (e: unknown) => e instanceof ConfigError && e.exitCode === 5,
      JSON.stringify(text),
    );
  }
}));

test('config: "version" that is no schema version — a fraction, a negative, null, a string, a huge number — is refused', inDir((dir) => {
  for (const version of [1.5, -1, 0, null, '2', true, 1e9]) {
    refused(write(dir, JSON.stringify({ version })));
  }
}));

test('config: "{}" and "$schema"+"version" alone are every built-in default', inDir((dir) => {
  for (const text of ['{}', JSON.stringify({ $schema: 'x', version: 3 })]) {
    write(dir, text);
    const config = loadConfig({ startDir: dir, useFile: true });
    assert.deepEqual({ ...config.generate }, { ...DEFAULT_SETTINGS }, text);
  }
}));

test('config: values at the edge of their kind — a count of 0 is a count; a negative, a fraction, a string, null are not', inDir((dir) => {
  const at = (bridgeGap: unknown): string => write(dir, JSON.stringify({ version: 3, generate: { bridgeGap } }));
  assert.deepEqual(readConfigFile(at(0)), { bridgeGap: 0 });
  for (const bad of [-1, 0.5, '1', null, true, [1]]) refused(at(bad));
}));

test('config: an empty object where a section goes is fine; a non-object there is refused', inDir((dir) => {
  assert.deepEqual(readConfigFile(write(dir, JSON.stringify({ version: 3, generate: {} }))), {});
  for (const generate of [null, [], 'x', 1]) refused(write(dir, JSON.stringify({ version: 3, generate })));
  for (const base of [null, [], 'main', true]) refused(write(dir, JSON.stringify({ version: 3, generate: { base } })));
}));
