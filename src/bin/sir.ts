#!/usr/bin/env node
// The `sir` command. Entries live in src/bin and do nothing but call `main`: a module
// of the CLI or the service runs nothing when imported, so the same code is a library,
// a command and — bundled into one file — `sir-apply`.
import { main } from '../cli/index.ts';

await main(process.argv.slice(2));
