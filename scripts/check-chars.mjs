import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Fail if any tracked source file contains a control or invisible character.
 *
 * This exists because a NUL byte got written into a source file and nothing noticed for
 * a while. Git decided the file was binary and stopped producing diffs for it, grep
 * stopped matching, and every editor rendered it as nothing at all. The character was
 * meant to be a separator and should have been written as an escape.
 *
 * The same check catches zero-width spaces and bidirectional overrides, which are worth
 * refusing on their own account: an identifier containing U+200B reads identically to one
 * that does not, and a right-to-left override can make a line of code display in an order
 * different from the one it executes in.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const CHECKED = /\.(ts|js|mjs|cjs|json|md|yml|yaml|html|css)$/;

/** Tab, newline and carriage return are the only control characters a source file needs. */
function isForbidden(code) {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a && code !== 0x0d;
  if (code === 0x7f) return true;
  // Zero-width and bidirectional formatting characters.
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x2028 && code <= 0x202e) return true;
  return code === 0xfeff;
}

const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!CHECKED.test(name)) continue;
    const text = readFileSync(path, 'utf8');
    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i);
      if (!isForbidden(code)) continue;
      hits.push({
        file: relative(process.cwd(), path),
        line: text.slice(0, i).split('\n').length,
        code,
        context: JSON.stringify(text.slice(Math.max(0, i - 30), i + 30)),
      });
    }
  }
}

walk(process.cwd());

if (hits.length === 0) {
  console.log('check-chars: no control or invisible characters in the tree');
  process.exit(0);
}

for (const h of hits) {
  const point = `U+${h.code.toString(16).toUpperCase().padStart(4, '0')}`;
  console.error(`${h.file}:${h.line}  ${point}  ${h.context}`);
}
console.error(
  `\n${hits.length} forbidden character${hits.length === 1 ? '' : 's'}. ` +
    'Write them as escape sequences, or build them with String.fromCodePoint.',
);
process.exit(1);
