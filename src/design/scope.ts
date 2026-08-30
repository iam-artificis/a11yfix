import type { StylesheetSource } from './palette.js';

/**
 * Deciding which stylesheets can possibly apply to a source file.
 *
 * The naive version — feed every stylesheet in the scan to every file — is wrong in a way
 * that only shows up on real repositories, and then shows up badly. A monorepo checkout
 * contains test fixtures, framework templates and half a dozen separate applications. One
 * of them containing `body { background-color: red }` is enough to make the analyser
 * report that white text fails against red on pages in unrelated packages. That happened,
 * on a well-known component library, and every one of those findings was confident,
 * error-severity and false.
 *
 * So a stylesheet is consulted only where there is evidence it reaches the file:
 *
 *   1. It lives in the same package — the nearest ancestor directory with a package.json.
 *      This is how bundlers actually scope a project, and it is right by default.
 *   2. The file names it: an `import './x.css'`, a `<link href>`, an `@import`. Across a
 *      package boundary this is the only evidence that counts, and when several files
 *      share a basename the nearest one on disk wins.
 *
 * Everything else is left out. A missing stylesheet costs a finding we could have made;
 * a wrong one costs the reader's trust in every finding we did make.
 */

const norm = (p: string): string => p.split('\\').join('/').toLowerCase();

const baseName = (p: string): string => {
  const n = norm(p);
  return n.slice(n.lastIndexOf('/') + 1);
};

/** True when `file` sits inside directory `dir`. */
function isUnder(file: string, dir: string): boolean {
  const f = norm(file);
  const d = norm(dir).replace(/\/+$/, '');
  return d === '' || f === d || f.startsWith(d + '/');
}

/** How much of the path two files share, in segments — used to break basename ties. */
function sharedDepth(a: string, b: string): number {
  const x = norm(a).split('/');
  const y = norm(b).split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * Stylesheet basenames a source file refers to.
 *
 * Deliberately a text scan rather than a module-resolution pass. Real projects reach
 * their CSS through aliases (`@workspace/ui/globals.css`), bundler magic and framework
 * conventions that no static resolver gets right, and the basename is the part that
 * survives all of them.
 */
export function referencedStylesheets(source: string): ReadonlySet<string> {
  const out = new Set<string>();
  const patterns = [
    // import "./globals.css" / import url from "@pkg/styles.css"
    /\bimport\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+\.(?:css|scss|sass|less))['"]/g,
    // require("./x.css"), import("./x.css")
    /\b(?:require|import)\s*\(\s*['"]([^'"]+\.(?:css|scss|sass|less))['"]\s*\)/g,
    // <link rel="stylesheet" href="/styles/main.css">
    /\bhref\s*=\s*['"]([^'"]+\.(?:css|scss|sass|less))['"]/g,
    // @import "theme.css";  @import url(theme.css);
    /@import\s+(?:url\(\s*)?['"]?([^'")\s]+\.(?:css|scss|sass|less))/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (spec !== undefined) out.add(baseName(spec));
    }
  }
  return out;
}

/**
 * Narrow a pool of stylesheets to those that could reach `file`.
 *
 * A sheet with no `scope` is treated as unconditionally applicable: that is the shape a
 * caller passing sheets explicitly through the API means, and second-guessing it would
 * make the library surprising.
 */
export function selectStylesheets(
  file: string,
  source: string,
  sheets: readonly StylesheetSource[],
): StylesheetSource[] {
  if (sheets.length === 0) return [];
  const referenced = referencedStylesheets(source);
  const picked: StylesheetSource[] = [];
  // Basename -> the best candidate seen so far, so a monorepo with four `globals.css`
  // contributes the one nearest this file rather than all four.
  const byBasename = new Map<string, StylesheetSource>();

  for (const sheet of sheets) {
    if (sheet.scope === undefined || isUnder(file, sheet.scope)) {
      picked.push(sheet);
      continue;
    }
    const base = baseName(sheet.file);
    if (!referenced.has(base)) continue;
    const current = byBasename.get(base);
    if (
      current === undefined ||
      sharedDepth(file, sheet.file) > sharedDepth(file, current.file)
    ) {
      byBasename.set(base, sheet);
    }
  }

  picked.push(...byBasename.values());
  return picked;
}
