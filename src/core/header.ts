import { ParseError } from './errors.ts';

// The header of a .hatch: `Name: value` lines, DEP-3 style, from the first non-blank
// line of the file to the first blank one.
//
//   Hatch: 1
//   Target: chrome/browser/feature_list.cc
//   Base-Blob: 3f2a9c1e…
//   Hatch-Version: 0.5.0
//   Grammar: tree-sitter-cpp@0.23.4
//
// `Hatch` is the format number and comes first (VERSIONING.md H1–H4); a file without a
// header is format 1. Names are read without regard to case, and a name hatch does not
// know is read past: a new field never needs a new number.
//
// The fields hatch knows have a fixed place: FIELDS, in this order, is the order they
// are written in and the order a reader holds them to. A new field goes to the end of
// the list — never between two that exist, never in place of one (H4) — so a header an
// older hatch wrote keeps its order in every later one.
//
// Places 3 and 4 were named `Generated-From` and `Generated-By` (`hatch <version>`) in
// 0.4.1 and were renamed in place in 0.5 — against H4, by the author's decision: the
// old names read wrongly in a patch written by hand. The old names are still read, in
// the same places, as the new ones (LEGACY_NAMES), so a header 0.4.1 wrote reads as
// before; they are never written and never given to another field.

export const FORMAT_MIN = 1;
export const FORMAT_VERSION = 1;

/** Every field hatch knows, in its place, with the name it has in `HeaderFields` — the
 *  ONE list the reader, the writer and the types are made of. Append only (H4). */
const FIELDS = [
  ['Hatch', null],
  ['Target', 'target'],
  ['Base-Blob', 'baseBlob'],
  ['Hatch-Version', 'hatchVersion'],
  ['Grammar', 'grammar'],
] as const;

export type HeaderFieldName = (typeof FIELDS)[number][0];
type FieldKey = NonNullable<(typeof FIELDS)[number][1]>;

/** The names, in their order: line 1 of a header is `Hatch`, the rest follow in this
 *  order, each at most once. */
export const HEADER_FIELDS: readonly HeaderFieldName[] = FIELDS.map(([name]) => name);

/** The names 0.4.1 wrote, lower-cased, and the field each is read as now. Never
 *  written, never reused. */
const LEGACY_NAMES: ReadonlyMap<string, HeaderFieldName> = new Map([
  ['generated-from', 'Base-Blob'],
  ['generated-by', 'Hatch-Version'],
]);

/** The place of a known field (0 is `Hatch`), or -1 for one hatch does not know. */
function fieldPosition(name: string): number {
  const lower = name.toLowerCase();
  const known = LEGACY_NAMES.get(lower)?.toLowerCase() ?? lower;
  return HEADER_FIELDS.findIndex((f) => f.toLowerCase() === known);
}

/** The fields beside the format number:
 *  - `target` — the file the patch is for, relative, with `/`;
 *  - `baseBlob` — the id of the git blob the patch was generated against;
 *  - `hatchVersion` — the version of hatch that wrote it, `0.5.0`;
 *  - `grammar` — `<package>@<version>`;
 *  - `generatedFrom`, `generatedBy` — the same two as protocol 4 names them:
 *    `generatedFrom` is `baseBlob`, `generatedBy` is `hatch <hatchVersion>`. Only read,
 *    never written; kept so a client of protocol 4 sees what it saw. */
export type HeaderFields = { [K in FieldKey]?: string | undefined } & {
  generatedFrom?: string | undefined;
  generatedBy?: string | undefined;
};

export interface ParsedHeader {
  readonly format: number;
  /** every field, its name lower-cased — a known one under its name of now, though
   *  written with a name of 0.4.1; the last one wins */
  readonly fields: ReadonlyMap<string, string>;
  /** the line after the header (its blank line included), counted from 0; 0 without one */
  readonly endLine: number;
}

/** A header as written, before it is held to the format range and to a safe `Target`
 *  — for a reader that has to tell those apart (`pair`). */
export interface HeaderLines extends ParsedHeader {
  /** the lines of `Hatch` and of `Target`, counted from 1 */
  readonly formatLine: number;
  readonly targetLine: number | undefined;
}

const FIELD = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*?)[ \t]*$/;

/** The header as written: every line `Name: value`, the known names in their order,
 *  each once, `Hatch` a number. Neither the range of that number nor `Target` is judged
 *  here — `parseHeader` does both. */
export function readHeader(text: string): HeaderLines {
  const lines = text.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  const head = first < lines.length ? FIELD.exec(lines[first]!) : null;
  if (head === null || head[1]!.toLowerCase() !== 'hatch') {
    return { format: 1, fields: new Map(), endLine: 0, formatLine: 0, targetLine: undefined };
  }

  const fields = new Map<string, string>();
  let last = -1;
  let lastWritten = '';
  let targetLine: number | undefined;
  let i = first;
  for (; i < lines.length && lines[i]!.trim() !== ''; i++) {
    const field = FIELD.exec(lines[i]!);
    if (field === null) {
      throw new ParseError(
        `a header line must be 'Name: value': '${lines[i]!.trim()}'`,
        i + 1,
        'the header ends at the first blank line — put one before the patch',
      );
    }
    const at = fieldPosition(field[1]!);
    // a known field is kept under its name of now, whatever name it was written with
    const name = at !== -1 ? HEADER_FIELDS[at]! : field[1]!;
    if (at !== -1) {
      if (fields.has(name.toLowerCase())) throw new ParseError(`the header names ${name} twice`, i + 1);
      if (at < last) {
        // the names as the file spells them: a header of 0.4.1 has its own
        throw new ParseError(
          `${field[1]!} must come before ${lastWritten} in the header`,
          i + 1,
          `the order is ${HEADER_FIELDS.join(', ')}; fields hatch does not know may stand anywhere after Hatch`,
        );
      }
      last = at;
      lastWritten = field[1]!;
      if (HEADER_FIELDS[at] === 'Target') targetLine = i + 1;
    }
    fields.set(name.toLowerCase(), field[2]!);
  }

  const value = fields.get('hatch')!;
  if (!/^\d+$/.test(value)) throw new ParseError(`Hatch must be a format number: '${value}'`, first + 1);
  return { format: Number(value), fields, endLine: i, formatLine: first + 1, targetLine };
}

/** The header, held to what every reader needs: a format this hatch reads, and a
 *  `Target` that stays inside its root. */
export function parseHeader(text: string): ParsedHeader {
  const header = readHeader(text);
  const side = formatSide(header.format);
  if (side !== undefined) {
    throw new ParseError(
      `the patch is format ${header.format}, this hatch reads ${FORMAT_MIN}–${FORMAT_VERSION}`,
      header.formatLine,
      side === 'newer' ? 'update hatch' : 'regenerate the patch',
    );
  }
  const target = header.fields.get('target');
  if (target !== undefined && !isContainedPath(target)) {
    throw new ParseError(
      `Target must be a relative path inside the project, with no '..': '${target}'`,
      header.targetLine ?? header.formatLine,
    );
  }
  return { format: header.format, fields: header.fields, endLine: header.endLine };
}

/** Which side a format outside the range is on — the side to update (H3) — or undefined
 *  for one this hatch reads. */
export function formatSide(format: number): 'newer' | 'older' | undefined {
  if (format > FORMAT_VERSION) return 'newer';
  if (format < FORMAT_MIN) return 'older';
  return undefined;
}

export function headerFields(parsed: ParsedHeader): HeaderFields {
  const out: HeaderFields = {};
  for (const [name, key] of FIELDS) {
    const value = key === null ? undefined : parsed.fields.get(name.toLowerCase());
    if (key !== null && value !== undefined) out[key] = value;
  }
  // `Generated-By` of 0.4.1 held `hatch <version>`; `Hatch-Version` holds the version
  if (out.hatchVersion !== undefined) out.hatchVersion = out.hatchVersion.replace(/^hatch\s+/i, '');
  if (out.baseBlob !== undefined) out.generatedFrom = out.baseBlob;
  if (out.hatchVersion !== undefined) out.generatedBy = `hatch ${out.hatchVersion}`;
  return out;
}

/** The header `generate` writes, its blank line after it: the fields it has, in the
 *  order of FIELDS. */
export function printHeader(fields: HeaderFields): string {
  const lines = FIELDS.flatMap(([name, key]) => {
    const value = key === null ? String(FORMAT_VERSION) : fields[key];
    return value !== undefined ? [`${name}: ${value}`] : [];
  });
  return `${lines.join('\n')}\n\n`;
}

/** `Target` is data out of a file that may have come with somebody else's repository,
 *  and the path decides what a client opens: it stays inside the root it is measured
 *  from. No `..` step, no absolute path, no Windows drive or UNC — whatever they would
 *  normalise to. */
export function isContainedPath(relPath: string): boolean {
  if (relPath === '') return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(relPath)) return false;
  return !relPath.split(/[\\/]/).includes('..');
}
