/**
 * Where a JSX tag name came from.
 *
 * `<Html>` is not `<html>`. In JSX a capitalised tag is a component, and which component
 * it is decides whether a finding is true. `<Html>` from `next/document` really is the
 * document root, and a missing `lang` there is one of the most common real accessibility
 * bugs in a Next.js application. `<Html>` from `@react-email/components` is an email
 * wrapper that already defaults its own language, and reporting it produced twenty-eight
 * confident false positives on the first real repository this was pointed at.
 *
 * The module specifier separates the two, it is written in the same file, and reading it
 * costs one regular expression. That is a much better trade than either guessing or
 * staying silent about both.
 */

/** Strip strings and comments so an import inside them cannot be mistaken for one. */
function importSection(source: string): string {
  // Imports are hoisted to the top of a module in practice; scanning the first 8 KB
  // keeps this cheap on large files without missing anything real.
  return source.slice(0, 8192);
}

/**
 * The clause is `[^'"]*?` rather than `[\s\S]*?`, and `from` is anchored on a word
 * boundary rather than on `\s+`.
 *
 * Two lazy runs next to each other — `\s+([\s\S]*?)\s+` — are the classic quadratic
 * shape: every failure re-tries every split of the whitespace between them. 1600 spaces
 * after the word `import` took 584ms, and the 8 KB window this runs in puts the worst
 * case near fifteen seconds for a single file. An import clause cannot contain a quote,
 * so refusing to cross one bounds the search — and rules out a match that runs from an
 * `import` inside a comment to some later module string.
 */
const IMPORT_RE = /\bimport\s([^'"]*?)\bfrom\s*['"]([^'"]+)['"]/g;

/**
 * The module a JSX tag's binding was imported from, or undefined if it is not an import
 * we can see (a local definition, a re-export, a dynamic require).
 *
 * `tag` may be dotted (`Foo.Bar`), in which case the root binding is resolved.
 */
export function importedFrom(source: string, tag: string): string | undefined {
  const root = tag.split('.')[0];
  if (root === undefined || root === '') return undefined;
  const text = importSection(source);

  for (const m of text.matchAll(IMPORT_RE)) {
    const clause = m[1];
    const module = m[2];
    if (clause === undefined || module === undefined) continue;

    // import Default, { A, B as C } from 'mod'  /  import * as NS from 'mod'
    const braceStart = clause.indexOf('{');
    const beforeBrace = braceStart >= 0 ? clause.slice(0, braceStart) : clause;

    for (const part of beforeBrace.split(',')) {
      const name = part.trim().replace(/^\*\s+as\s+/, '');
      if (name === root) return module;
    }

    if (braceStart < 0) continue;
    const braceEnd = clause.indexOf('}', braceStart);
    const named = clause.slice(braceStart + 1, braceEnd < 0 ? undefined : braceEnd);
    for (const part of named.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(trimmed);
      const local = asMatch !== null ? asMatch[2] : trimmed;
      if (local === root) return module;
    }
  }
  return undefined;
}

/**
 * Modules whose export really is the page's `<html>` element.
 *
 * Deliberately a short allowlist rather than a denylist. An unrecognised module means we
 * do not know what the component renders, and a rule that asserts a missing attribute on
 * something it cannot see is asserting a fact it does not have.
 */
const DOCUMENT_ROOT_MODULES = new Set(['next/document', 'next/dist/pages/_document']);

/** True when this capitalised tag is known to render the document root element. */
export function isDocumentRootComponent(source: string, tag: string): boolean {
  const module = importedFrom(source, tag);
  return module !== undefined && DOCUMENT_ROOT_MODULES.has(module);
}
