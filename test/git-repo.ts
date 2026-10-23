import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface Repo {
  readonly dir: string;
  readonly inPath: string;
  readonly branch: string;
  readonly a: string;
  readonly b: string;
  readonly s: string;
}

export const OTHER = 'void g() {\n  int b = 7;\n}\n';
export const SIDE_ONLY = 'void f() {\n  int a = 1;\n  int side = 1;\n}\n';

export function version(n: number): string {
  return `void f() {\n  int a = ${n};\n}\n`;
}

export function buildRepo(prefix: string): Repo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'test');

  mkdirSync(join(dir, 'src', 'core'), { recursive: true });
  const inPath = join(dir, 'src', 'core', 'f.cc');
  writeFileSync(inPath, version(1));
  writeFileSync(join(dir, 'src', 'core', 'other.cc'), OTHER);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const a = git('rev-parse', 'HEAD');

  writeFileSync(inPath, version(2));
  git('add', '-A');
  git('commit', '-q', '-m', 'second');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const b = git('rev-parse', 'HEAD');
  git('tag', 'v1.0', b);
  git('update-ref', 'refs/remotes/origin/main', b);

  git('checkout', '-q', '-b', 'side', a);
  writeFileSync(inPath, version(3));
  writeFileSync(join(dir, 'src', 'core', 'side-only.cc'), SIDE_ONLY);
  git('add', '-A');
  git('commit', '-q', '-m', 'side');
  const s = git('rev-parse', 'HEAD');
  git('checkout', '-q', branch);

  writeFileSync(inPath, version(4));
  return { dir, inPath, branch, a, b, s };
}
