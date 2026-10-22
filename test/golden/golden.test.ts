import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesize } from '../../src/generate/synth.ts';
import { printHatchFile } from '../../src/generate/printer.ts';
import { printHeader } from '../../src/core/header.ts';
import { parseHatchFile } from '../../src/core/hatch-parser.ts';
import { applyAll } from '../../src/core/apply.ts';
import { AmbiguityError, MatchError, SynthesisError } from '../../src/core/errors.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';
import type { LanguageAdapter } from '../../src/lang/source-map.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

/** The line a golden describes itself in: the first — the second after a `#!` line, which
 *  a script must keep on top. */
const headLine = (text: string): string => {
  const [first = '', second = ''] = text.split('\n', 2);
  return first.startsWith('#!') ? second : first;
};

const mustRefuse = (text: string): boolean => headLine(text).includes('MUST-REFUSE');

const knownGap = (text: string): boolean => text.slice(0, 400).includes('KNOWN-GAP');

function describe(text: string): string {
  const m = /^(?:\/\/|#|<!--|\/\*)\s*(\[.*?)(?:\s*(?:-->|\*\/))?$/.exec(headLine(text).replace(/\r$/, ''));
  return m === null ? '' : ` ${m[1]!.trim()}`;
}

const adapters = new Map<string, LanguageAdapter>();
async function adapterFor(language: string): Promise<LanguageAdapter> {
  let a = adapters.get(language);
  if (a === undefined) {
    a = adapterForLanguage(language);
    await a.init();
    adapters.set(language, a);
  }
  return a;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const languages = readdirSync(HERE)
  .filter((name) => isDir(join(HERE, name)))
  .sort();

for (const language of languages) {
  const generateDir = join(HERE, language, 'generate');
  const applyDir = join(HERE, language, 'apply');

  if (isDir(generateDir)) {
    const files = readdirSync(generateDir);
    const numbers = [...new Set(files.map((f) => /^test(\d+)\.old\./.exec(f)?.[1]).filter(Boolean))]
      .map(Number)
      .sort((a, b) => a - b);

    for (const n of numbers) {
      const oldFile = files.find((f) => f.startsWith(`test${n}.old.`))!;
      const newFile = files.find((f) => f.startsWith(`test${n}.new.`));
      if (newFile === undefined) {
        test(`golden ${language}/generate/${n}`, () => assert.fail(`${oldFile} has no test${n}.new.* beside it`));
        continue;
      }
      const oldStr = readFileSync(join(generateDir, oldFile), 'utf8');
      const newStr = readFileSync(join(generateDir, newFile), 'utf8');
      const goldenPath = join(generateDir, `test${n}.hatch`);

      test(`golden ${language}/generate/${n}${describe(oldStr)}`, async () => {
        const adapter = await adapterFor(language);

        if (knownGap(oldStr)) {
          // a gap is synthesis saying it cannot anchor the change — a crash is no gap
          assert.throws(
            () => synthesize(oldStr, newStr, adapter),
            (e: unknown) => e instanceof SynthesisError,
            'this case synthesizes now — remove the KNOWN-GAP marker and commit the golden .hatch',
          );
          return;
        }

        // what `generate` writes: the header, then the heading in the language's own name.
        // Not `Hatch-Version` — it would change every golden on every release — and no
        // `Base-Blob`: the old version is a file here, not a git blob.
        const header = printHeader({
          target: `test/golden/${language}/generate/${newFile}`,
          grammar: adapter.grammar === undefined ? undefined : `${adapter.grammar.package}@${adapter.grammar.version}`,
        });
        const md = header + printHatchFile(synthesize(oldStr, newStr, adapter), adapter.name);

        const applied = applyAll(oldStr, parseHatchFile(md), adapter).source;
        assert.equal(applied, newStr, 'applying the generated patch did not reproduce the new file');

        if (UPDATE) {
          writeFileSync(goldenPath, md);
          return;
        }
        assert.ok(
          existsSync(goldenPath),
          `no golden for ${language}/generate/${n}: run \`UPDATE_GOLDEN=1 npm test\`, ` +
            'read the produced .hatch, and commit it only if it is what you meant',
        );
        assert.equal(
          md,
          readFileSync(goldenPath, 'utf8'),
          `the printed form changed. If that is intended: UPDATE_GOLDEN=1 npm test, then read the diff`,
        );
      });
    }
  }

  if (isDir(applyDir)) {
    const files = readdirSync(applyDir);
    const numbers = files
      .map((f) => /^test(\d+)\.hatch$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);

    for (const n of numbers) {
      const sourceFile = files.find(
        (f) => f.startsWith(`test${n}.`) && !f.endsWith('.hatch') && !f.startsWith(`test${n}.expected.`),
      );
      if (sourceFile === undefined) {
        test(`golden ${language}/apply/${n}`, () => assert.fail(`test${n}.hatch has no test${n}.<ext> source beside it`));
        continue;
      }
      const source = readFileSync(join(applyDir, sourceFile), 'utf8');
      const md = readFileSync(join(applyDir, `test${n}.hatch`), 'utf8');

      const expectedPath = join(applyDir, `test${n}.expected${extname(sourceFile)}`);

      test(`golden ${language}/apply/${n}${describe(source)}`, async () => {
        const adapter = await adapterFor(language);
        const run = (): string => applyAll(source, parseHatchFile(md), adapter).source;

        if (mustRefuse(source)) {
          // refused as a patch is refused — no place, or two; a crash is no refusal
          assert.throws(
            run,
            (e: unknown) => e instanceof MatchError || e instanceof AmbiguityError,
            'these instructions applied, and they must not',
          );
          return;
        }
        const result = run();
        assert.notEqual(result, source, 'the patch applied but changed nothing');
        // a header names this golden's own source; only a hand-written patch has none
        const target = parseHatchFile(md).header?.target;
        if (target !== undefined) assert.equal(target, `test/golden/${language}/apply/${sourceFile}`, 'Target names the source');

        if (UPDATE) {
          writeFileSync(expectedPath, result);
          return;
        }
        assert.ok(
          existsSync(expectedPath),
          `no expected result for ${language}/apply/${n}: run \`UPDATE_GOLDEN=1 npm test\`, ` +
            'read the produced file, and commit it only if it is what you meant',
        );
        assert.equal(
          result,
          readFileSync(expectedPath, 'utf8'),
          'applying these instructions no longer produces the recorded result',
        );
      });
    }
  }
}
