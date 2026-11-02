export interface StringRule {
  readonly open: string | RegExp;
  readonly close: string | ((open: RegExpExecArray) => string | RegExp);
  readonly escape?: string;
  readonly multiline?: boolean;
  readonly opaque?: boolean;
}

export interface Zone {
  readonly start: number;
  readonly end: number;
  readonly opaque: boolean;
}

export function stringZones(text: string, rules: readonly StringRule[]): Zone[] {
  const compiled = rules.map(compile);
  const out: Zone[] = [];
  let i = 0;
  while (i < text.length) {
    const zone = zoneAt(text, i, compiled);
    if (zone === null) {
      i++;
      continue;
    }
    out.push(zone);
    i = zone.end;
  }
  return out;
}

export function replaceWhitespaceOutsideStrings(
  text: string,
  rules: readonly StringRule[],
  collapse: (ws: string, offset: number) => string,
): string {
  const zones = stringZones(text, rules).filter((z) => z.opaque);
  if (zones.length === 0) return text.replace(/\s+/g, collapse);
  return text.replace(/\s+/g, (ws: string, offset: number) =>
    inZone(zones, offset) ? ws : collapse(ws, offset),
  );
}

export function inZone(zones: readonly Zone[], offset: number): boolean {
  let lo = 0;
  let hi = zones.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const z = zones[mid]!;
    if (offset < z.start) hi = mid - 1;
    else if (offset >= z.end) lo = mid + 1;
    else return true;
  }
  return false;
}

interface Compiled {
  readonly open: string | RegExp;
  readonly close: string | ((open: RegExpExecArray) => string | RegExp);
  readonly escape: string | undefined;
  readonly multiline: boolean;
  readonly opaque: boolean | undefined;
}

function compile(rule: StringRule): Compiled {
  const open =
    typeof rule.open === 'string' ? rule.open : new RegExp(rule.open.source, stickyFlags(rule.open));
  return {
    open,
    close: rule.close,
    escape: rule.escape,
    multiline: rule.multiline === true,
    opaque: rule.opaque,
  };
}

function stickyFlags(re: RegExp): string {
  return re.flags.includes('y') ? re.flags : `${re.flags}y`;
}

function zoneAt(text: string, start: number, rules: readonly Compiled[]): Zone | null {
  for (const rule of rules) {
    const opened = matchOpen(text, start, rule.open);
    if (opened === null) continue;
    const closer = typeof rule.close === 'string' ? rule.close : rule.close(opened.match);
    const end = findClose(text, start + opened.length, closer, rule);
    return { start, end, opaque: rule.opaque ?? !text.slice(start, end).includes('\n') };
  }
  return null;
}

function matchOpen(
  text: string,
  at: number,
  open: string | RegExp,
): { length: number; match: RegExpExecArray } | null {
  if (typeof open === 'string') {
    if (!text.startsWith(open, at)) return null;
    return { length: open.length, match: [open] as unknown as RegExpExecArray };
  }
  open.lastIndex = at;
  const m = open.exec(text);
  if (m === null || m.index !== at || m[0].length === 0) return null;
  return { length: m[0].length, match: m };
}

function findClose(text: string, from: number, closer: string | RegExp, rule: Compiled): number {
  const esc = rule.escape;
  const sticky = typeof closer === 'string' ? undefined : new RegExp(closer.source, stickyFlags(closer));
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (esc !== undefined && ch === esc) {
      i++;
      continue;
    }
    if (!rule.multiline && ch === '\n') return i;
    if (sticky === undefined) {
      if (text.startsWith(closer as string, i)) return i + (closer as string).length;
    } else {
      sticky.lastIndex = i;
      const m = sticky.exec(text);
      if (m !== null && m.index === i) return i + m[0].length;
    }
  }
  return text.length;
}
