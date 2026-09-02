import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type {
  FileKind,
  FileResult,
  Fix,
  FixSafety,
  Level,
  Rule,
  RuleContext,
  RunSummary,
  Violation,
} from './types.js';
import { parseMarkup, positionAt } from './parse/markup.js';
import type { ParsedMarkup } from './parse/markup.js';
import { Palette } from './design/palette.js';
import type { StylesheetSource } from './design/palette.js';
import { applyEdits, selectEdits } from './fix/apply.js';
import { applySuppressions, findSuppressions } from './suppress.js';
import { selectStylesheets } from './design/scope.js';

export const VERSION = '0.1.0';

/**
 * File extensions we are willing to parse as markup.
 *
 * `.ts` and `.js` are deliberately absent. They can contain JSX only by convention, but
 * they very often contain HTML inside string literals — test fixtures, template helpers,
 * email bodies. Parsing those produces confident findings about markup that is not a page
 * and cannot be rendered, which was the single largest source of noise when this was
 * first measured against real repositories.
 */
const KIND_BY_EXT: Readonly<Record<string, FileKind>> = {
  '.html': 'html',
  '.htm': 'html',
  '.jsx': 'jsx',
  '.tsx': 'jsx',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.css': 'css',
  '.scss': 'css',
  '.astro': 'html',
};

export function kindOf(file: string): FileKind | undefined {
  return KIND_BY_EXT[extname(file).toLowerCase()];
}

/** How much of an element goes into an excerpt, before whitespace is collapsed. */
const EXCERPT_WINDOW = 160;

function tidy(raw: string): string {
  const cleaned = raw.replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 120) return cleaned;
  // Not between the halves of a surrogate pair. `slice` counts UTF-16 units, so a cut
  // inside an emoji leaves a lone surrogate, and the excerpt is the part of a finding a
  // client reads most closely — it is the evidence.
  let cut = 119;
  const last = cleaned.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return cleaned.slice(0, cut) + '…';
}

/** Trim an excerpt and neutralise control characters so printing a report is safe. */
function excerptAt(source: string, start: number, end: number): string {
  return tidy(source.slice(start, Math.min(end, start + EXCERPT_WINDOW)));
}

/**
 * The same excerpt with the fix applied — the line as it should read.
 *
 * The patch is the most persuasive thing this tool produces, and the report, which is what
 * the person paying for the work actually reads, described it in a sentence instead of
 * showing it. It matters most where there is no patch at all: a scan of a live URL has no
 * file to change, and a museum's content editor cannot apply a diff but can retype one
 * line. Withholding it there withheld the whole deliverable.
 *
 * Only for fixes that would really be written. A `manual` fix, or one carrying an
 * advisory, is a suggestion for a person to weigh, and printing it as the corrected line
 * would state a certainty the tool does not have. Every edit must fall inside the window
 * or none is shown: half a change presented as the finished line is worse than no line.
 */
function fixedExcerptAt(
  source: string,
  start: number,
  end: number,
  fix: Fix | undefined,
): string | undefined {
  if (fix === undefined || fix.edits.length === 0) return undefined;
  if (fix.safety === 'manual' || fix.advisory !== undefined) return undefined;
  const stop = Math.min(end, start + EXCERPT_WINDOW);
  if (!fix.edits.every((e) => e.start >= start && e.end <= stop && e.end >= e.start)) {
    return undefined;
  }
  let raw = source.slice(start, stop);
  for (const e of [...fix.edits].sort((a, b) => b.start - a.start)) {
    raw = raw.slice(0, e.start - start) + e.replacement + raw.slice(e.end - start);
  }
  return tidy(raw);
}

export interface AnalyseOptions {
  readonly rules: readonly Rule[];
  readonly level: Level;
  /** Stylesheets to consult when resolving colours. */
  readonly stylesheets?: readonly StylesheetSource[];
  readonly disabled?: ReadonlySet<string>;
  /** Highest safety level of fix that may be written to disk. */
  readonly fixThreshold?: FixSafety | null;
  /**
   * Also write the placeholder markers for findings a machine cannot decide — an
   * unnamed link, an icon-only button. They fail CI by design; see fixAllowed.
   */
  readonly markTodos?: boolean;
}

/** Analyse one already-loaded file. */
export function analyseSource(
  file: string,
  source: string,
  options: AnalyseOptions,
): FileResult {
  const kind = kindOf(file) ?? 'html';

  // Parsing and colour resolution used to sit above the guard that protects rule
  // execution below, and a throw here therefore ended the whole run rather than one file.
  // It did: `background: constructor` reached a table lookup that answered with the Object
  // function, the process exited 2, and every other file in the repository went unscanned
  // with no output at all. A file this tool cannot read is a finding about that file.
  let markup: ParsedMarkup;
  let palette: Palette;
  try {
    // Template literals only exist in the JavaScript-family formats; in a .html file a
    // backtick is ordinary text and masking on it would hide half the document.
    markup = parseMarkup(source, { skipTemplateLiterals: kind !== 'html' && kind !== 'css' });
    // Only the stylesheets that can actually reach this file. See design/scope.ts for why
    // "all of them" is not a safe default on anything larger than a single app.
    const sheets = selectStylesheets(file, source, options.stylesheets ?? []);
    palette = new Palette(markup, file, sheets);
  } catch (err) {
    return {
      file,
      kind,
      violations: [
        {
          ruleId: 'A11Y-META-001',
          wcag: [],
          level: 'A',
          severity: 'warning',
          file,
          start: 0,
          end: 0,
          line: 1,
          column: 1,
          message: `This file could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'This file was not analysed at all. Treat the result as incomplete, not clean.',
          excerpt: '',
        },
      ],
      appliedFixes: 0,
      skippedFixes: 0,
    };
  }

  const violations: Violation[] = [];
  const ctx: RuleContext = {
    file,
    source,
    markup,
    level: options.level,
    palette,
    report(v) {
      const pos = positionAt(source, v.start);
      const excerpt = excerptAt(source, v.start, v.end);
      const fixed = fixedExcerptAt(source, v.start, v.end, v.fix);
      return {
        ...v,
        file,
        line: pos.line,
        column: pos.column,
        excerpt,
        // Identical means the edit changed something outside the window, or nothing that
        // survives whitespace collapsing. Either way there is nothing to show.
        ...(fixed !== undefined && fixed !== excerpt ? { excerptFixed: fixed } : {}),
      };
    },
  };

  for (const rule of options.rules) {
    if (options.disabled?.has(rule.id) === true) continue;
    if (!rule.appliesTo.includes(kind)) continue;
    try {
      violations.push(...rule.run(ctx));
    } catch (err) {
      // A crashing rule must not take down a repository-wide run, but dropping it
      // silently would make the report quietly incomplete, which is worse.
      violations.push({
        ruleId: 'A11Y-META-001',
        wcag: [],
        level: 'A',
        severity: 'warning',
        file,
        start: 0,
        end: 0,
        line: 1,
        column: 1,
        message: `Rule ${rule.id} failed on this file: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'This file was not fully analysed. Treat the result as incomplete, not clean.',
        excerpt: '',
      });
    }
  }

  violations.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.ruleId < b.ruleId ? -1 : 1));

  // A comment in the file can hide a finding on one line. Applied after the rules run
  // rather than before, so a suppression that no longer matches anything can be reported
  // instead of quietly outliving the problem it was written for.
  const { kept, suppressed, unused } = applySuppressions(violations, findSuppressions(source));
  const unusedSuppressions = unused.map((s) => s.commentLine);

  if (options.fixThreshold == null) {
    return {
      file,
      kind,
      violations: kept,
      suppressed,
      unusedSuppressions,
      appliedFixes: 0,
      skippedFixes: kept.filter((v) => v.fix !== undefined).length,
    };
  }

  const { edits, applied, skipped } = selectEdits(
    kept,
    options.fixThreshold,
    options.markTodos ?? false,
  );
  const result = applyEdits(source, edits);
  return {
    file,
    kind,
    violations: kept,
    suppressed,
    unusedSuppressions,
    fixedSource: result.output,
    appliedFixes: applied - result.conflicted.length,
    skippedFixes: skipped + result.conflicted.length,
  };
}

/** Analyse a list of files from disk. */
export async function analyseFiles(
  files: readonly string[],
  options: AnalyseOptions,
): Promise<RunSummary> {
  const started = Date.now();

  // Stylesheets are read once and shared, because a component's colours usually live in
  // a file other than the one being analysed.
  const sheets: StylesheetSource[] = [...(options.stylesheets ?? [])];
  const packageRoots = new Map<string, string>();
  for (const file of files) {
    if (kindOf(file) !== 'css') continue;
    try {
      sheets.push({
        file,
        content: await readFile(file, 'utf8'),
        scope: await packageRootOf(file, packageRoots),
      });
    } catch {
      /* unreadable stylesheet: colours from it simply stay undetermined */
    }
  }

  const results: FileResult[] = [];
  for (const file of files) {
    if (kindOf(file) === 'css') continue;
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    results.push(analyseSource(file, source, { ...options, stylesheets: sheets }));
  }

  const all = results.flatMap((r) => r.violations);
  const byRuleCount = new Map<string, number>();
  for (const v of all) byRuleCount.set(v.ruleId, (byRuleCount.get(v.ruleId) ?? 0) + 1);

  return {
    files: results,
    totals: {
      violations: all.length,
      errors: all.filter((v) => v.severity === 'error').length,
      warnings: all.filter((v) => v.severity === 'warning').length,
      info: all.filter((v) => v.severity === 'info').length,
      automatic: all.filter((v) => v.fix?.safety === 'automatic').length,
      review: all.filter((v) => v.fix?.safety === 'review').length,
      manual: all.filter((v) => v.fix?.safety === 'manual').length,
      fixed: results.reduce((n, r) => n + r.appliedFixes, 0),
    },
    byRule: [...byRuleCount.entries()]
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort((a, b) => b.count - a.count),
    durationMs: Date.now() - started,
  };
}

/**
 * The nearest ancestor directory containing a package.json, which is the closest thing
 * to a bundler's idea of "this project" that we can see from the filesystem alone.
 *
 * Results are memoised per directory, including the directories walked through on the
 * way up, so a scan of a few thousand files does a handful of stat calls rather than one
 * per file per level.
 */
export async function packageRootOf(file: string, cache: Map<string, string>): Promise<string> {
  const walked: string[] = [];
  let dir = dirname(file);
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      for (const d of walked) cache.set(d, cached);
      return cached;
    }
    walked.push(dir);
    let found = false;
    try {
      found = (await stat(join(dir, 'package.json'))).isFile();
    } catch {
      found = false;
    }
    const parent = dirname(dir);
    if (found || parent === dir) {
      for (const d of walked) cache.set(d, dir);
      return dir;
    }
    dir = parent;
  }
}
