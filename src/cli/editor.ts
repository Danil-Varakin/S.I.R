import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The editor a person edits hunks in, chosen the way git chooses it: $VISUAL, then
// $EDITOR, then the one every system has. It runs with the terminal as its own: stdin,
// and stderr for its screen too — stdout may be where the patch goes (`--out -`).

export function editorCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  for (const value of [env['VISUAL'], env['EDITOR']]) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return platform === 'win32' ? 'notepad' : 'vi';
}

/** Runs `command file` and waits for it. A command may carry its own arguments
 *  (`code --wait`), so it goes through the shell, the file as a separate argument. */
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

/** One file for the whole run, made on the first edit. It is left in place when the run
 *  stops, so that nothing typed into it is lost; `discard` removes it after a success. */
export interface EditSession {
  edit(text: string): Promise<string>;
  /** the file, once something was edited */
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
