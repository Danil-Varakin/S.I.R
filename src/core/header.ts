import { ParseError } from './errors.ts';

export const FORMAT_MIN = 2;
export const FORMAT_VERSION = 2;

const BARE_HUNKS_UNTIL = 2;

/** Every field sir knows, in its place, with the name it has in `HeaderFields` — the
 *  ONE list the reader, the writer and the types are made of. Append only (H4). */
const FIELDS = [
  ['Sir', null],
  ['Target', 'target'],
  ['Base-Blob', 'baseBlob'],
  ['Sir-Version', 'sirVersion'],
  ['Grammar', 'grammar'],
] as const;

export type HeaderFieldName = (typeof FIELDS)[number][0];
type FieldKey = NonNullable<(typeof FIELDS)[number][1]>;

export const HEADER_FIELDS: readonly HeaderFieldName[] = FIELDS.map(([name]) => name);

function fieldPosition(name: string): number {
  const lower = name.toLowerCase();
  return HEADER_FIELDS.findIndex((f) => f.toLowerCase() === lower);
}

export type HeaderFields = { [K in FieldKey]?: string | undefined };

export interface ParsedHeader {
  readonly format: number;
  readonly fields: ReadonlyMap<string, string>;
  readonly endLine: number;
}

export interface HeaderLines extends ParsedHeader {
  readonly formatLine: number;
  readonly targetLine: number | undefined;
}

const FIELD = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*?)[ \t]*$/;

export function readHeader(text: string): HeaderLines {
  const lines = text.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  const head = first < lines.length ? FIELD.exec(lines[first]!) : null;
  if (head === null || !['sir', 'hatch'].includes(head[1]!.toLowerCase())) {
    const format = FORMAT_MIN <= BARE_HUNKS_UNTIL ? FORMAT_MIN : 1;
    return { format, fields: new Map(), endLine: 0, formatLine: 0, targetLine: undefined };
  }
  if (head[1]!.toLowerCase() === 'hatch') {
    let end = first;
    while (end < lines.length && lines[end]!.trim() !== '') end++;
    return { format: 1, fields: new Map(), endLine: end, formatLine: first + 1, targetLine: undefined };
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
    const name = at !== -1 ? HEADER_FIELDS[at]! : field[1]!;
    if (at !== -1) {
      if (fields.has(name.toLowerCase())) throw new ParseError(`the header names ${name} twice`, i + 1);
      if (at < last) {
        throw new ParseError(
          `${field[1]!} must come before ${lastWritten} in the header`,
          i + 1,
          `the order is ${HEADER_FIELDS.join(', ')}; fields sir does not know may stand anywhere after Sir`,
        );
      }
      last = at;
      lastWritten = field[1]!;
      if (HEADER_FIELDS[at] === 'Target') targetLine = i + 1;
    }
    fields.set(name.toLowerCase(), field[2]!);
  }

  const value = fields.get('sir')!;
  if (!/^\d+$/.test(value)) throw new ParseError(`Sir must be a format number: '${value}'`, first + 1);
  return { format: Number(value), fields, endLine: i, formatLine: first + 1, targetLine };
}

export function parseHeader(text: string): ParsedHeader {
  const header = readHeader(text);
  const side = formatSide(header.format);
  if (side !== undefined) {
    throw new ParseError(
      `the patch is format ${header.format}, this sir reads ${FORMAT_MIN}–${FORMAT_VERSION}`,
      header.formatLine,
      side === 'newer' ? 'update sir' : 'regenerate the patch',
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
  return out;
}

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
