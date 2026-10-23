for (const stream of [process.stdin, process.stderr]) {
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
}
