import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { GrammarError } from '../core/errors.ts';
import type { GrammarSource } from '../lang/source-map.ts';
import { embeddedAsset, isSingleExecutable } from './runtime.ts';

export type { GrammarSource } from '../lang/source-map.ts';

// Grammars ship inside sir: `grammars/` of the package, filled at build time by
// scripts/fetch-grammars.ts from the pins in src/lang/*/index.ts. Nothing is downloaded
// at run time and there is no user cache. A grammar is executable code and shapes where
// a hunk lands (F3), so the bytes must be exactly the pinned ones — a file that is not
// is refused, wherever it was found.

const GRAMMAR_DIR_ENV = 'SIR_GRAMMAR_DIR';

export async function resolveGrammar(source: GrammarSource, language?: string): Promise<Uint8Array> {
  validate(source);
  if (source.path === undefined && isSingleExecutable()) {
    const bytes = embeddedAsset(source.file);
    if (bytes === null) throw new GrammarError(`grammar ${describe(source)} is missing from this build of sir-apply`, describe(source));
    checkPin(source, bytes, `sir-apply:${source.file}`);
    return bytes;
  }
  const candidates = source.path !== undefined ? [source.path] : grammarDirs().map((dir) => join(dir, source.file));
  for (const path of candidates) {
    const bytes = await readIfExists(path);
    if (bytes === null) continue;
    checkPin(source, bytes, path);
    return bytes;
  }
  const what = language !== undefined ? `the ${language} grammar (${describe(source)})` : `grammar ${describe(source)}`;
  throw new GrammarError(
    `${what} is missing from this build of sir — a fault of the build, not of your setup\n` +
      `  looked in:\n${candidates.map((c) => `    ${c}`).join('\n')}`,
    describe(source),
  );
}

export function grammarDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env[GRAMMAR_DIR_ENV];
  if (override !== undefined && override !== '') dirs.push(override);
  dirs.push(packageGrammarDir());
  return dirs;
}

export function packageGrammarDir(): string {
  return join(import.meta.dirname, '..', '..', 'grammars');
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkPin(source: GrammarSource, bytes: Uint8Array, path: string): void {
  if (source.sha256 === undefined) return;
  const got = digest(bytes);
  if (got === source.sha256) return;
  throw new GrammarError(
    `${path} is not the grammar ${describe(source)} pins: sha256 ${got}, the pin ${source.sha256}. ` +
      'Another grammar can place hunks differently (F3): put the pinned file there, or remove it',
    describe(source),
  );
}

function validate(source: GrammarSource): void {
  if (typeof source.file !== 'string' || source.file === '') {
    throw new GrammarError('grammar source has no file name');
  }
  if (source.path !== undefined && !isAbsolute(source.path)) {
    throw new GrammarError(`grammar path must be absolute: ${source.path}`, describe(source));
  }
  if (source.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(source.sha256)) {
    throw new GrammarError('a grammar pin is a hex sha256', describe(source));
  }
}

function describe(source: GrammarSource): string {
  if (source.package !== undefined) return source.version !== undefined ? `${source.package}@${source.version}` : source.package;
  return source.path ?? source.file;
}

async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}
