// Fills grammars/ of the package with the grammars src/lang/*/index.ts pins — for
// development, CI and `npm pack` only: sir itself never downloads anything
// (src/infra/grammar-store.ts). Every file is checked against its sha256 pin; a file
// already there with the right bytes is left alone.
//
//   node --experimental-strip-types scripts/fetch-grammars.ts
//   node --experimental-strip-types scripts/fetch-grammars.ts --pin tree-sitter-go@0.25.0
//       download one grammar and print the block to paste into a new language's index.ts
//
// Where the bytes come from, in order: grammars/ itself; the user cache sir 0.1–0.3
// filled (a machine that ran it has them, and they are checked like any other); the npm
// CDNs, jsdelivr then unpkg; last, for a package whose npm archive has no .wasm
// (@tree-sitter-grammars/tree-sitter-xml), the GitHub Release of the same version — its
// repository read from the npm registry, its tag `v<version>`. The pin is the same in
// every case, and so is the check.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { adaptersByName } from '../src/lang/adapter.ts';
import { digest, packageGrammarDir } from '../src/infra/grammar-store.ts';
import type { GrammarSource } from '../src/lang/source-map.ts';

const TIMEOUT_MS = 60_000;

function urls(source: GrammarSource): string[] {
  const spec = `${source.package!}@${source.version!}/${source.file}`;
  return [`https://cdn.jsdelivr.net/npm/${spec}`, `https://unpkg.com/${spec}`];
}

/** The file in the GitHub Release `v<version>` of the package's repository, as the npm
 *  registry names it; undefined when the repository is not on GitHub. */
async function releaseUrl(source: GrammarSource): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${source.package!}/${source.version!}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = (await response.json()) as { repository?: string | { url?: string } };
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/.exec(repository ?? '');
  if (m === null) return undefined;
  return `https://github.com/${m[1]!}/${m[2]!}/releases/download/v${source.version!}/${source.file}`;
}

/** The pinned bytes from the CDNs, then from the GitHub Release; every source checked. */
async function downloadPinned(source: GrammarSource, failures: string[]): Promise<Uint8Array | undefined> {
  for (const url of urls(source)) {
    const got = await tryDownload(url, source, failures);
    if (got !== undefined) return got;
  }
  let release: string | undefined;
  try {
    release = await releaseUrl(source);
  } catch (e) {
    failures.push(`npm registry: ${(e as Error).message}`);
  }
  return release === undefined ? undefined : tryDownload(release, source, failures);
}

async function tryDownload(url: string, source: GrammarSource, failures: string[]): Promise<Uint8Array | undefined> {
  try {
    const got = await download(url);
    if (source.sha256 !== undefined && digest(got) !== source.sha256) {
      throw new Error(`checksum mismatch: expected ${source.sha256}, received ${digest(got)}`);
    }
    return got;
  } catch (e) {
    failures.push(`${url}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Where sir 0.1–0.3 kept its downloads — read, never written. */
function legacyCacheEntry(source: GrammarSource): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const root =
    xdg !== undefined && xdg !== ''
      ? join(xdg, 'sir', 'grammars')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches', 'sir', 'grammars')
        : process.platform === 'win32'
          ? join(process.env['LOCALAPPDATA'] ?? homedir(), 'sir', 'grammars')
          : join(homedir(), '.cache', 'sir', 'grammars');
  return join(root, `${source.package!.replace('/', '+')}@${source.version!}`, source.file);
}

async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchPinned(source: GrammarSource, dir: string): Promise<'present' | 'copied' | 'downloaded'> {
  const target = join(dir, source.file);
  const there = await readIfExists(target);
  if (there !== null && digest(there) === source.sha256) return 'present';

  const cached = await readIfExists(legacyCacheEntry(source));
  let bytes: Uint8Array | undefined = cached !== null && digest(cached) === source.sha256 ? cached : undefined;
  const how = bytes !== undefined ? 'copied' : 'downloaded';
  const failures: string[] = [];
  bytes ??= await downloadPinned(source, failures);
  if (bytes === undefined) throw new Error(`could not get ${source.file}\n  ${failures.join('\n  ')}`);

  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, target);
  return how;
}

async function pin(spec: string): Promise<void> {
  const at = spec.lastIndexOf('@');
  if (at <= 0) throw new Error(`cannot read "${spec}" as <package>@<version>`);
  const pkg = spec.slice(0, at);
  const version = spec.slice(at + 1);
  const file = `${pkg.split('/').pop()}.wasm`;
  const failures: string[] = [];
  const bytes = await downloadPinned({ file, package: pkg, version }, failures);
  if (bytes === undefined) throw new Error(`could not get ${file}\n  ${failures.join('\n  ')}`);
  process.stdout.write(
    [
      '  grammar: {',
      `    file: '${file}',`,
      `    package: '${pkg}',`,
      `    version: '${version}',`,
      `    sha256: '${digest(bytes)}',`,
      '  },',
    ].join('\n') + '\n',
  );
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === '--pin') {
    if (argv[1] === undefined) throw new Error('--pin <package>@<version>');
    await pin(argv[1]);
    return;
  }
  const dir = packageGrammarDir();
  await mkdir(dir, { recursive: true });
  const seen = new Set<string>();
  const counts = { present: 0, copied: 0, downloaded: 0 };
  for (const adapter of adaptersByName().values()) {
    const grammar = adapter.grammar;
    if (grammar === undefined || seen.has(grammar.file)) continue; // a language read as text pins none
    seen.add(grammar.file);
    counts[await fetchPinned(grammar, dir)]++;
  }
  process.stderr.write(
    `grammars/: ${seen.size} grammar(s) — ${counts.present} present, ${counts.copied} copied, ${counts.downloaded} downloaded\n`,
  );
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`fetch-grammars: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
