import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Run the test suite.
 *
 * A three-line script instead of `node --test test/*.test.js` because that line is
 * quietly not portable: the shell expands the glob on Linux, PowerShell does not, and
 * Node only learned to expand it itself in v22. On Windows with Node 20 it fails with
 * "could not find", which is how this was discovered. Resolving the list here works
 * everywhere and — unlike naming the files by hand — cannot silently skip a new one.
 */

const dir = new URL('../test/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error('No test files found. That is a broken checkout, not a passing suite.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
