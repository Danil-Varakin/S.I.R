// Loaded with --import into a hatch run a test starts: the process takes its stdin and
// stderr for a terminal, as when a person runs it. The answers still come down a pipe,
// so the test types them; nothing else about the run changes. node-pty is not needed for
// what hatch reads of a terminal — `isTTY` on the two streams (cli/confirm.ts, atTerminal).
for (const stream of [process.stdin, process.stderr]) {
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
}
