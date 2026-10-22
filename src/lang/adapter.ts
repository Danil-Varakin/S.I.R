import { basename, extname } from 'node:path';
import type { LanguageAdapter } from './source-map.ts';
import { LanguageError } from '../core/errors.ts';
import { cppAdapter } from './cpp/index.ts';
import { cAdapter } from './c/index.ts';
import { objcAdapter } from './objc/index.ts';
import { pythonAdapter } from './python/index.ts';
import { javascriptAdapter } from './javascript/index.ts';
import { typescriptAdapter } from './typescript/index.ts';
import { tsxAdapter } from './tsx/index.ts';
import { rustAdapter } from './rust/index.ts';
import { javaAdapter } from './java/index.ts';
import { kotlinAdapter } from './kotlin/index.ts';
import { goAdapter } from './go/index.ts';
import { htmlAdapter } from './html/index.ts';
import { xmlAdapter } from './xml/index.ts';
import { json5Adapter } from './json5/index.ts';
import { idlAdapter } from './idl/index.ts';
import { mojomAdapter } from './mojom/index.ts';
import { protoAdapter } from './proto/index.ts';
import { shellAdapter } from './shell/index.ts';
import { yamlAdapter } from './yaml/index.ts';
import { tomlAdapter } from './toml/index.ts';
import { textAdapter } from './text/index.ts';
import { cssAdapter } from './css/index.ts';
import { jsonAdapter } from './json/index.ts';

// Names a person writes: `# match c++`, `--language golang`.
const NAMES: ReadonlyMap<string, LanguageAdapter> = new Map([
  ['cpp', cppAdapter],
  ['c++', cppAdapter],
  ['cc', cppAdapter],
  ['cxx', cppAdapter],
  ['h', cppAdapter],
  ['hpp', cppAdapter],
  ['c', cAdapter],
  ['objc', objcAdapter],
  ['objective-c', objcAdapter],
  ['objectivec', objcAdapter],
  ['objcpp', objcAdapter],
  ['objective-c++', objcAdapter],
  ['python', pythonAdapter],
  ['py', pythonAdapter],
  ['javascript', javascriptAdapter],
  ['js', javascriptAdapter],
  ['jsx', javascriptAdapter],
  ['mjs', javascriptAdapter],
  ['cjs', javascriptAdapter],
  ['typescript', typescriptAdapter],
  ['ts', typescriptAdapter],
  ['tsx', tsxAdapter],
  ['rust', rustAdapter],
  ['rs', rustAdapter],
  ['java', javaAdapter],
  ['kotlin', kotlinAdapter],
  ['kt', kotlinAdapter],
  ['go', goAdapter],
  ['golang', goAdapter],
  ['html', htmlAdapter],
  ['xml', xmlAdapter],
  ['css', cssAdapter],
  ['json', jsonAdapter],
  ['json5', json5Adapter],
  // read as text — no grammar (make-text-adapter.ts)
  ['idl', idlAdapter],
  ['mojom', mojomAdapter],
  ['proto', protoAdapter],
  ['protobuf', protoAdapter],
  ['shell', shellAdapter],
  ['yaml', yamlAdapter],
  ['toml', tomlAdapter],
  ['text', textAdapter],
]);

const REGISTRY: readonly LanguageAdapter[] = [...new Set(NAMES.values())];

// ...and every extension a language claims in its own folder, spelled without the dot:
// hatch 0.2.0 and earlier wrote that word into `# match` (`in.mm` → `# match mm`), and
// every such patch has to apply the same forever, so `apply` reads each one back as the
// same language. Derived, not listed: a language that claims an extension gets its name
// with it, and the two cannot drift apart. The map stays static — built from the
// adapters imported above, never from a name that arrived in a patch.
const ALIASES: ReadonlyMap<string, LanguageAdapter> = withExtensionWords(NAMES, REGISTRY);

function withExtensionWords(
  names: ReadonlyMap<string, LanguageAdapter>,
  adapters: readonly LanguageAdapter[],
): Map<string, LanguageAdapter> {
  const out = new Map(names);
  for (const adapter of adapters) {
    for (const extension of adapter.extensions) {
      const word = extension.slice(1);
      if (!out.has(word)) out.set(word, adapter);
    }
  }
  return out;
}

export const supportedLanguages: readonly string[] = [...ALIASES.keys()];

export function adaptersByName(): ReadonlyMap<string, LanguageAdapter> {
  return ALIASES;
}

export function adapterForLanguage(name: string | undefined): LanguageAdapter {
  if (name === undefined || name.trim() === '') {
    throw new LanguageError(
      `language is not specified: put it in the heading (# match cpp) or pass --language; ` +
        `supported: ${supportedLanguages.join(', ')}`,
    );
  }
  const adapter = ALIASES.get(name.trim().toLowerCase());
  if (adapter === undefined) {
    throw new LanguageError(`unsupported language '${name}'; supported: ${supportedLanguages.join(', ')}`, {
      language: name,
    });
  }
  return adapter;
}

export function adapterForFile(path: string): LanguageAdapter {
  const name = basename(path);
  for (const adapter of REGISTRY) {
    if (adapter.fileNames?.includes(name) === true) return adapter;
  }
  const ext = extensionOf(path);
  for (const adapter of REGISTRY) {
    if (adapter.extensions.includes(ext)) return adapter;
  }
  const known = REGISTRY.flatMap((a) => a.extensions).join(', ');
  throw new LanguageError(`no adapter for file extension '${ext || '(none)'}'; known: ${known}`, {
    extension: ext,
  });
}

/** The adapter for a job, from the most explicit source that names a language: the
 *  one named outright (`--language`, `params.language`), else the `# match` heading of
 *  the patch, else the extension of the file. The one order for apply, generate and the
 *  service; an empty name counts as not named, wherever it comes from. */
export function pickAdapter(from: {
  readonly language?: string | undefined;
  readonly heading?: string | undefined;
  readonly path?: string | undefined;
}): LanguageAdapter {
  const named = namedLanguage(from.language) ?? namedLanguage(from.heading);
  if (named !== undefined) return adapterForLanguage(named);
  if (from.path !== undefined) return adapterForFile(from.path);
  return adapterForLanguage(undefined); // throws, listing what is supported
}

/** The name of the adapter `pickAdapter` would pick for the job — the word `generate`
 *  writes in `# match` — or null when it picks none: an extension no adapter carries, a
 *  name no adapter answers to. No grammar is loaded. */
export function pickedLanguage(from: Parameters<typeof pickAdapter>[0]): string | null {
  return pickedAdapter(from)?.name ?? null;
}

/** The adapter `pickAdapter` would pick, or null when it picks none. No grammar is
 *  loaded: what `config` says of a file — its `# match` word, its `Grammar` — is read off
 *  the adapter as it stands. */
export function pickedAdapter(from: Parameters<typeof pickAdapter>[0]): LanguageAdapter | null {
  try {
    return pickAdapter(from);
  } catch (e) {
    if (e instanceof LanguageError) return null;
    throw e;
  }
}

/** A language name as given, or undefined when it is empty — the same as not given. */
export function namedLanguage(name: string | undefined): string | undefined {
  return name === undefined || name.trim() === '' ? undefined : name;
}

/** The extension of a file, lower-cased and with its dot; `''` when there is none. Read
 *  from the file's NAME only — a dot in a directory (`my.proj/Makefile`) is not one. */
export function extensionOf(path: string): string {
  return extname(path).toLowerCase();
}

/** A heading is a promise about the file it will be applied to: `apply` reads
 *  `# match <word>` back through this same registry. A word that leads to another
 *  language — or to none — would make a patch that `apply` refuses or reads wrongly, so
 *  it is refused while the patch is still being written. An empty word writes a bare
 *  `# match`, and `apply` then goes by the extension of the file it is given. */
export function checkHeading(word: string, adapter: LanguageAdapter): void {
  if (word.trim() === '') return;
  const readBack = ALIASES.get(word.trim().toLowerCase());
  if (readBack === adapter) return;
  const as = readBack === undefined ? 'no language at all' : `language '${readBack.name}'`;
  throw new LanguageError(
    `'# match ${word}' would be read back by apply as ${as}, not as '${adapter.name}'; ` +
      `supported: ${supportedLanguages.join(', ')}`,
    { language: word },
  );
}
