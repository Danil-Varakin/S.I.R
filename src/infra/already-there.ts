import { alreadyThere } from '../core/apply.ts';
import type { AlreadyThere } from '../core/apply.ts';
import type { SirFile } from '../core/ast.ts';
import type { LanguageAdapter } from '../lang/source-map.ts';
import { blobText } from './git.ts';

export async function alreadyThereAt(
  copies: readonly number[],
  file: SirFile,
  adapter: LanguageAdapter,
  near: string | undefined,
  laidOn: { readonly text: string; readonly blob?: string | undefined },
): Promise<AlreadyThere> {
  if (copies.every((n) => n === 0)) return { kind: 'clear' };
  const id = file.header?.baseBlob;
  let base: string | undefined;
  if (id !== undefined) base = id === laidOn.blob ? laidOn.text : near === undefined ? undefined : await blobText(near, id);
  return alreadyThere(copies, file, adapter, base);
}

export function unwitnessedWarning(hunk: number, total: number, file: SirFile): string {
  const id = file.header?.baseBlob;
  const why =
    id === undefined
      ? 'the patch names no Base-Blob to tell whether upstream wrote it'
      : `its Base-Blob ${id.slice(0, 12)} cannot tell whether upstream wrote it (not in this repository, or the patch does not lay on it)`;
  return `hunk ${hunk + 1} of ${total}: the text it inserts already stands at its place, and ${why} — laid all the same`;
}
