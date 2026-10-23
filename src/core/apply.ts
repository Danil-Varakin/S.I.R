import { matchPattern } from './matcher.ts';
import { applyEdit, planEdit } from './patcher.ts';
import type { Edit } from './patcher.ts';
import type { SirFile, Hunk } from './ast.ts';
import type { LanguageAdapter, SourceMap } from '../lang/source-map.ts';

export interface AppliedEdit {
  edit: Edit;
  oldText: string;
}

export interface ApplyResult {
  source: string;
  edits: AppliedEdit[];
}

export function applyAll(source: string, file: SirFile, adapter: LanguageAdapter): ApplyResult {
  let current = source;
  const edits: AppliedEdit[] = [];
  for (const hunk of file.hunks) {
    const edit = planHunk(current, adapter.buildMap(current), hunk, adapter);
    edits.push({ edit, oldText: current.slice(edit.start, edit.end) });
    current = applyEdit(current, edit);
  }
  return { source: current, edits };
}

export function planHunk(current: string, map: SourceMap, hunk: Hunk, adapter: LanguageAdapter): Edit {
  return planEdit(current, map, matchPattern(hunk.match, map, adapter.normalize), hunk.patch);
}
