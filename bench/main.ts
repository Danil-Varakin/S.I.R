// The only file here that runs anything, as src/bin/* is for the product. A bad argument
// is a one-line refusal and exit 1, not a stack trace: this is a tool, not a test.
import { main } from './run.ts';

try {
  await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exitCode = 1;
}
