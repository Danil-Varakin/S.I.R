import { getAsset, isSea } from 'node:sea';

export function embeddedAsset(name: string): Uint8Array | null {
  if (!isSea()) return null;
  try {
    return new Uint8Array(getAsset(name));
  } catch {
    return null;
  }
}

export function isSingleExecutable(): boolean {
  return isSea();
}
