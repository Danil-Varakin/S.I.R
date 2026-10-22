import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { editorCommand, editSession, runEditor } from '../../src/cli/editor.ts';

test('editorCommand: $VISUAL, then $EDITOR, then the one every system has', () => {
  assert.equal(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' }, 'linux'), 'code --wait');
  assert.equal(editorCommand({ VISUAL: '  ', EDITOR: 'nano' }, 'linux'), 'nano');
  assert.equal(editorCommand({}, 'darwin'), 'vi');
  assert.equal(editorCommand({}, 'win32'), 'notepad');
});

// An "editor" that is a command with arguments of its own, as `code --wait` is: node,
// told to write into the file it is given.
const FAKE = `node -e "require('fs').appendFileSync(process.argv[1], 'typed\\\\n')"`;

test('editSession: the text goes to the editor, what it saved comes back; the file stays until discarded', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the fake editor is a POSIX shell command');
    return;
  }
  const session = editSession(FAKE);
  assert.equal(await session.edit('first\n'), 'first\ntyped\n');
  assert.equal(await session.edit('second\n'), 'second\ntyped\n', 'the same file, overwritten');
  const file = session.file!;
  assert.ok(existsSync(file));
  session.discard();
  assert.equal(existsSync(file), false);
});

test('runEditor: an editor that fails stops the run and says how to pick another', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shell');
    return;
  }
  assert.throws(() => runEditor('false', '/dev/null'), /the editor \(false\) exited with 1[\s\S]*set VISUAL or EDITOR/);
});

test('runEditor: on Windows the command line goes through the shell, the file quoted after it', () => {
  // the shell is the system's own here too, so the branch runs on any platform
  assert.doesNotThrow(() => runEditor('true', '/dev/null', 'win32'));
  assert.throws(() => runEditor('false', '/dev/null', 'win32'), /the editor \(false\) exited with 1 — nothing was written/);
});

test('runEditor: an editor killed by a signal is named by the signal', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shell');
    return;
  }
  assert.throws(() => runEditor('kill -TERM $$ #', '/dev/null', 'linux'), /the editor \(kill -TERM \$\$ #\) exited with SIGTERM — nothing was written/);
});
