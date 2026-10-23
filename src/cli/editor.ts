import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function editorCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  for (const value of [env['VISUAL'], env['EDITOR']]) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return platform === 'win32' ? 'notepad' : 'vi';
}

export function runEditor(command: string, file: string, platform: string = process.platform): void {
  const run =
    platform === 'win32'
      ? spawnSync(`${command} "${file}"`, { shell: true, stdio: [0, 2, 2] })
      : spawnSync('/bin/sh', ['-c', `${command} "$1"`, command, file], { stdio: [0, 2, 2] });
  if (run.error !== undefined) throw new Error(`cannot start the editor (${command}): ${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(
      `the editor (${command}) exited with ${run.status ?? run.signal} — nothing was written\n` +
        '  set VISUAL or EDITOR to the editor to use',
    );
  }
}

export interface EditSession {
  edit(text: string): Promise<string>;
  readonly file: string | undefined;
  discard(): void;
}

export function editSession(command: string = editorCommand()): EditSession {
  let dir: string | undefined;
  let file: string | undefined;
  return {
    get file() {
      return file;
    },
    edit(text) {
      dir ??= mkdtempSync(join(tmpdir(), 'sir-edit-'));
      file ??= join(dir, 'hunks.sirp');
      writeFileSync(file, text, 'utf8');
      runEditor(command, file);
      return Promise.resolve(readFileSync(file, 'utf8'));
    },
    discard() {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
      file = undefined;
    },
  };
}
