import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CONFIG_FILE_NAME } from '../../src/infra/config/index.ts';

// .github/schemastore/catalog-entry.json is what goes into SchemaStore's catalog, so that
// editors find sir.config.schema.json by the file's name, with no "$schema" in it. The
// catalog's own CI refuses an entry that breaks its rules; these are those rules, checked
// here first, and the ties between the entry, the schema and the code.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;

const entry = read('.github/schemastore/catalog-entry.json');
const schema = read('sir.config.schema.json');

test('SchemaStore entry: exactly the fields the catalog takes', () => {
  assert.deepEqual(Object.keys(entry).sort(), ['description', 'fileMatch', 'name', 'url']);
});

test('SchemaStore entry: name and description as the catalog wants them', () => {
  for (const field of ['name', 'description'] as const) {
    const text = entry[field] as string;
    assert.equal(typeof text, 'string', field);
    assert.ok(text.trim() !== '', `${field}: empty`);
    assert.ok(!/\n/.test(text), `${field}: a newline`);
    assert.ok(!/\bschema\b/i.test(text), `${field}: the word "schema" is not allowed`);
    assert.ok(!/^[\p{P}\s]/u.test(text) && !/[\p{P}\s]$/u.test(text), `${field}: punctuation or space at an edge`);
  }
});

test('SchemaStore entry: it matches the file sir looks for', () => {
  assert.deepEqual(entry['fileMatch'], [CONFIG_FILE_NAME]);
});

test('SchemaStore entry: an absolute https URL, the same the schema names itself by', () => {
  const url = entry['url'] as string;
  assert.match(url, /^https:\/\//);
  assert.equal(url, schema['$id'], 'catalog url and $id are one address');
  assert.ok(url.endsWith('/main/sir.config.schema.json'), 'the file in the repository, on main');
});

test('the schema itself: a JSON Schema dialect, a title and a description to show', () => {
  assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(typeof schema['title'], 'string');
  assert.equal(typeof schema['description'], 'string');
});
