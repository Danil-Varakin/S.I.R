import { isAbsolute } from 'node:path';
import type { GitSourceParams, OverridesParams } from './protocol.ts';
import { namedLanguage } from '../lang/adapter.ts';
import { GIT_EOLS } from '../infra/git.ts';
import type { GitEol, GitSource } from '../infra/git.ts';
import { basesOnGit, gitSourceOf, overridesFrom } from '../infra/config/index.ts';
import type { GenerateSettings, PartialSettings } from '../infra/config/index.ts';
import { loadProject } from '../infra/project.ts';
import type { LoadedProject } from '../infra/project.ts';
import { isPatchPath } from '../infra/pair.ts';
import { BadRequest } from './request.ts';

// What a request settles over the project's config — the ONE reading of it. `generate`
// takes it from its own params, `config` and `pair` from `overrides`; the same names go
// through this same code, so `config` answers exactly what `generate` would apply.

/** The config that speaks for `path` (`infra/project.ts`: up from it, else the one
 *  whose upstream claims it; `configPath` before all) — none without a path or a
 *  `configPath` — with the request's settings over it, and the project it describes. */
export function settingsFor(path: string | undefined, o: OverridesParams): LoadedProject {
  if (o.configPath !== undefined && (typeof o.configPath !== 'string' || !isAbsolute(o.configPath))) {
    throw new BadRequest('configPath must be an absolute path to a sir.config.json');
  }
  return loadProject({
    path,
    search: { explicitPath: o.configPath, isPatch: path !== undefined && isPatchPath(path) },
    useFile: path !== undefined || o.configPath !== undefined,
    flags: requestOverrides(o),
  });
}

/** Where the base comes from: the client's text, git as the request names it, git as
 *  the config names it — or nowhere (null), which `generate` refuses. */
export type BaseChoice = { readonly kind: 'text' } | { readonly kind: 'git'; readonly source: GitSource };

export function baseChoice(settings: GenerateSettings, o: OverridesParams): BaseChoice | null {
  if (o.base === 'text') return { kind: 'text' };
  // The request's own baseGit, repoPath and all; its fields are in `settings` already.
  if (o.baseGit !== undefined) return { kind: 'git', source: { ...gitSource(o.baseGit), eol: settings.baseEol } };
  if (basesOnGit(settings)) return { kind: 'git', source: gitSourceOf(settings) };
  return null;
}

export function checkOverrides(o: OverridesParams, name: string): void {
  if (o.base !== undefined && o.base !== 'text') {
    throw new BadRequest(`${name}.base must be "text" — the client sends baseText — or be left out`);
  }
  if (o.base !== undefined && o.baseGit !== undefined) {
    throw new BadRequest(
      `send exactly one base: ${name}.base "text" (the client sends the old version) or ${name}.baseGit`,
    );
  }
  if (o.baseGit !== undefined) gitSource(o.baseGit, `${name}.baseGit`);
}

function requestOverrides(o: OverridesParams) {
  const values: PartialSettings = {
    language: namedLanguage(o.language),
    exact: o.exact,
    bridgeGap: o.bridgeGap,
    out: o.out,
    ...(o.limits ?? {}),
    ...baseOverrides(o),
  };
  return overridesFrom(values, (spec) =>
    spec.path.startsWith('generate.base.') ? (o.base === 'text' ? 'params.baseText' : 'params.baseGit') : `params.${spec.key}`,
  );
}

/** A base sent in the request replaces the config's `generate.base` whole, its line
 *  endings included, so the settings answered back say where this run's base came from. */
function baseOverrides(o: OverridesParams): PartialSettings {
  if (o.base === 'text') return { baseHead: false, baseBranch: null, baseCommit: null, baseEol: 'repository' };
  if (o.baseGit === undefined) return {};
  const source = gitSource(o.baseGit);
  return {
    baseHead: true,
    baseBranch: source.branch ?? null,
    baseCommit: source.commit ?? null,
    baseEol: source.eol ?? 'repository',
    // repoPath is no setting: it names one run's file (C6)
  };
}

const GIT_FIELDS = new Set(['branch', 'commit', 'repoPath', 'eol']);

/** The ONE place the wire names become the resolver's names — `repoPath` is `path`
 *  there, and both types have nothing but optional fields, so a field left behind
 *  would be no type error at all, just a coordinate that quietly does nothing.
 *
 *  A coordinate misspelt over the wire is refused by name for the same reason: a client
 *  sending `branch` as `ref` would otherwise get the default and never learn why. */
function gitSource(value: unknown, name = 'params.baseGit'): GitSource {
  if (value === null || typeof value !== 'object') throw new BadRequest(`${name} must be an object`);
  const wire = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(wire)) {
    if (!GIT_FIELDS.has(key)) {
      throw new BadRequest(`${name} has no field '${key}'; known: ${[...GIT_FIELDS].join(', ')}`);
    }
    if (key === 'eol') {
      if (!GIT_EOLS.includes(field as GitEol)) {
        throw new BadRequest(`${name}.eol must be ${GIT_EOLS.map((e) => `"${e}"`).join(' or ')}`);
      }
    } else if (typeof field !== 'string' || field === '') {
      throw new BadRequest(`${name}.${key} must be a non-empty string`);
    }
  }
  const named = wire as GitSourceParams;
  return { branch: named.branch, commit: named.commit, path: named.repoPath, eol: named.eol };
}
