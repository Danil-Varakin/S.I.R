import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageIdentity {
  readonly name: string;
  readonly version: string;
}

const UNKNOWN: PackageIdentity = { name: 'sir', version: '0.0.0' };

// Set by scripts/build-apply-bin.mjs: inside sir-apply there is no package.json.
declare const __SIR_VERSION__: string | undefined;

export function packageIdentity(): PackageIdentity {
  if (typeof __SIR_VERSION__ === 'string') return { name: 'sir', version: __SIR_VERSION__ };
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { name?: string; version?: string };
    return { name: pkg.name ?? UNKNOWN.name, version: pkg.version ?? UNKNOWN.version };
  } catch {
    return UNKNOWN;
  }
}
