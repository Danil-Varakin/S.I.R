import { getAsset, isSea } from 'node:sea';

// The one place that knows whether this is `sir-apply` — a single executable with its
// files inside — or the package, which has them on disk. Inside the binary there is no
// package directory: the tree-sitter runtime and the grammars are assets of the
// executable (scripts/build-apply-bin.mjs).

/** The bytes of an asset built into this executable, or null when this is not one, or
 *  the executable has no asset of that name. */
export function embeddedAsset(name: string): Uint8Array | null {
  if (!isSea()) return null;
  try {
    return new Uint8Array(getAsset(name));
  } catch {
    return null;
  }
}

/** Whether this process is `sir-apply`. */
export function isSingleExecutable(): boolean {
  return isSea();
}
