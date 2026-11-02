export interface PreprocRules {
  readonly open: RegExp;
  readonly middle: RegExp;
  readonly close: RegExp;
}

const MOST = 4;

export function preprocVariants(source: string, rules: PreprocRules): string[] {
  const lines = source.split('\n');
  const groups: { branches: number; hasElse: boolean; net: Map<number, number> }[] = [];
  const path: { group: number; branch: number }[][] = [];
  const directive: boolean[] = [];
  const open: { group: number; branch: number }[] = [];
  for (const line of lines) {
    if (rules.open.test(line)) {
      groups.push({ branches: 1, hasElse: false, net: new Map() });
      open.push({ group: groups.length - 1, branch: 0 });
      directive.push(true);
      path.push([]);
    } else if (open.length > 0 && rules.middle.test(line)) {
      const top = open[open.length - 1]!;
      top.branch++;
      groups[top.group]!.branches = top.branch + 1;
      if (/^\s*#\s*else\b/.test(line)) groups[top.group]!.hasElse = true;
      directive.push(true);
      path.push([]);
    } else if (open.length > 0 && rules.close.test(line)) {
      open.pop();
      directive.push(true);
      path.push([]);
    } else {
      directive.push(false);
      path.push(open.map((o) => ({ ...o })));
      const net = bracketNet(line);
      if (net !== 0) for (const o of open) groups[o.group]!.net.set(o.branch, (groups[o.group]!.net.get(o.branch) ?? 0) + net);
    }
  }
  if (groups.length === 0) return [];
  const unbalanced = (g: number): boolean => [...groups[g]!.net.values()].some((n) => n !== 0);
  const branchesOf = (g: number): number => groups[g]!.branches + (groups[g]!.hasElse || !unbalanced(g) ? 0 : 1);
  const count = Math.min(MOST, Math.max(...groups.map((_, g) => branchesOf(g))));
  const blank = (line: string): string => line.replace(/[^\n]/g, ' ');
  const variants: string[] = [];
  for (let k = 0; k < count; k++) {
    variants.push(
      lines
        .map((line, i) => {
          if (directive[i]) return blank(line);
          const kept = path[i]!.every((p) => Math.min(k, branchesOf(p.group) - 1) === p.branch);
          return kept ? line : blank(line);
        })
        .join('\n'),
    );
  }
  return variants;
}

function bracketNet(line: string): number {
  const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').replace(/\/\/.*$/, '');
  let net = 0;
  for (const ch of code) {
    if (ch === '{' || ch === '(' || ch === '[') net++;
    else if (ch === '}' || ch === ')' || ch === ']') net--;
  }
  return net;
}
