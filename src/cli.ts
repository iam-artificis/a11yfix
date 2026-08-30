#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FixSafety, Level, RunSummary, Violation } from './types.js';
import { analyseSource, kindOf, packageRootOf, VERSION } from './engine.js';
import { isIgnored, loadConfig } from './config.js';
import { buildBaseline, compareToBaseline, readBaseline, writeBaseline } from './baseline.js';
import { renderReport } from './report.js';
import { countByFixClass, fixClass } from './fix/classify.js';
import { unifiedDiff } from './fix/apply.js';
import { ALL_RULES } from './rules/index.js';
import type { StylesheetSource } from './design/palette.js';

/**
 * The command line.
 *
 * Default behaviour is to report and change nothing. Writing to someone's source has to
 * be asked for explicitly, and even then only fixes with one provably correct answer are
 * applied unless the user opts into the reviewable ones as well.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.turbo', 'vendor', '__pycache__', '.venv', 'target', '.cache', 'storybook-static',
]);

const DEFAULT_BASELINE = '.a11yfix-baseline.json';
const DEFAULT_REPORT = 'a11yfix-report.html';

interface Options {
  paths: string[];
  level: Level;
  fix: boolean;
  includeReview: boolean;
  diff: boolean;
  json: boolean;
  quiet: boolean;
  listRules: boolean;
  all: boolean;
  /** Rule ids switched off on the command line, merged with the config file's. */
  disable: string[];
  /** Path to a baseline to compare against, or to write with --baseline-write. */
  baseline?: string;
  baselineEnabled: boolean;
  baselineWrite: boolean;
  /** Path for --report, or undefined when it was not asked for. */
  report?: string;
  /** Glob patterns from --ignore, merged with the config file's. */
  ignore: string[];
  /** Set when --level was passed, so a config file cannot override an explicit flag. */
  levelFromFlag: boolean;
  /** Files --fix could not write, filled in during the run rather than parsed. */
  writeFailures?: { file: string; reason: string }[];
  help: boolean;
  version: boolean;
  maxFiles: number;
}

/** What the report says it audited: the paths asked for, or the working directory. */
function reportSubject(paths: readonly string[]): string {
  if (paths.length === 0 || (paths.length === 1 && paths[0] === '.')) {
    const cwd = process.cwd();
    const parts = cwd.split(/[\\/]/).filter((p) => p !== '');
    return parts[parts.length - 1] ?? cwd;
  }
  return paths.join(', ');
}

/** The command that reproduces this report, printed in its footer. */
function reportCommand(paths: readonly string[]): string {
  return `a11yfix ${paths.length === 0 ? '.' : paths.join(' ')} --report`;
}

function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    paths: [],
    level: 'AA',
    fix: false,
    includeReview: false,
    diff: false,
    json: false,
    quiet: false,
    listRules: false,
    all: false,
    disable: [],
    baselineEnabled: false,
    baselineWrite: false,
    ignore: [],
    levelFromFlag: false,
    help: false,
    version: false,
    maxFiles: 5000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case '--fix': o.fix = true; break;
      case '--include-review': o.includeReview = true; break;
      case '--diff': o.diff = true; break;
      case '--json': o.json = true; break;
      case '--quiet': case '-q': o.quiet = true; break;
      case '--rules': o.listRules = true; break;
      case '--all': o.all = true; break;
      case '--help': case '-h': o.help = true; break;
      case '--version': case '-v': o.version = true; break;
      case '--level': {
        const v = argv[++i];
        if (v === 'A' || v === 'AA' || v === 'AAA') {
          o.level = v;
          o.levelFromFlag = true;
        }
        break;
      }
      case '--report': {
        // The path is optional, like --baseline. Without one the report lands next to
        // wherever the user is standing, under a name they will recognise later.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          o.report = next;
          i++;
        } else {
          o.report = DEFAULT_REPORT;
        }
        break;
      }
      case '--baseline': {
        // The path is optional. Consuming the next argument unconditionally turned
        // `--baseline --quiet` into an attempt to read a baseline called "--quiet".
        o.baselineEnabled = true;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          o.baseline = next;
          i++;
        }
        break;
      }
      case '--baseline-write': {
        o.baselineWrite = true;
        // The path is optional; without one the conventional filename is used.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          o.baseline = next;
          i++;
        }
        break;
      }
      case '--disable': {
        const v = argv[++i];
        if (v !== undefined) o.disable.push(...v.split(',').map((x) => x.trim()).filter((x) => x !== ''));
        break;
      }
      case '--ignore': {
        const v = argv[++i];
        if (v !== undefined) o.ignore.push(v);
        break;
      }
      case '--max-files': o.maxFiles = Number(argv[++i]) || o.maxFiles; break;
      default:
        if (!a.startsWith('-')) o.paths.push(a);
    }
  }
  if (o.paths.length === 0) o.paths.push('.');
  return o;
}

async function collectFiles(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= max || depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && kindOf(full) !== undefined) {
        out.push(full);
      }
    }
  }
  const info = await stat(root).catch(() => null);
  if (info === null) return [];
  if (info.isFile()) return kindOf(root) !== undefined ? [root] : [];
  await walk(root, 0);
  return out;
}

const ESC = String.fromCodePoint(0x1b);
const C = {
  reset: ESC + '[0m', bold: ESC + '[1m', dim: ESC + '[2m',
  red: ESC + '[31m', yellow: ESC + '[33m', blue: ESC + '[34m',
  green: ESC + '[32m', grey: ESC + '[90m',
};

/** Colour is suppressed when output is piped, so reports stay readable in CI logs. */
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const c = (code: string, s: string): string => (useColor ? code + s + C.reset : s);

/** "1 file", "2 files" — sloppy plurals in a precision tool read as carelessness. */
function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

function severityTag(v: Violation): string {
  if (v.severity === 'error') return c(C.red, 'error  ');
  if (v.severity === 'warning') return c(C.yellow, 'warning');
  return c(C.blue, 'info   ');
}

/**
 * How many times one rule may repeat inside one file before the rest are counted.
 *
 * Not a cosmetic limit. A vendored demo page in one real repository produced 1256
 * findings from a single file — 91% of everything the run reported — and the effect on a
 * reader is not "this file is bad", it is "this tool is broken". The remainder is always
 * counted out loud, because silently truncating a report is the same lie as not finding
 * the problems in the first place.
 */
const PER_RULE_PER_FILE = 3;

function printViolation(v: Violation, opts: Options): void {
  const wcag = v.wcag.length > 0 ? c(C.grey, ` WCAG ${v.wcag.join(', ')}`) : '';
  console.log(`  ${c(C.grey, `${v.line}:${v.column}`)}  ${severityTag(v)}  ${v.message}${wcag}`);
  if (opts.quiet) return;
  console.log(`          ${c(C.dim, v.impact)}`);
  if (v.excerpt !== '') console.log(`          ${c(C.grey, v.excerpt)}`);
  if (v.fix !== undefined) {
    const applicability = fixClass(v);
    if (applicability === 'manual') {
      const advice = v.fix.advisory ?? (v.fix.edits.length > 0 ? v.fix.description : undefined);
      if (advice !== undefined) {
        console.log(`          ${c(C.blue, 'needs a person:')} ${advice}`);
      }
    } else {
      const tag =
        applicability === 'automatic' ? c(C.green, 'auto-fixable') : c(C.yellow, 'fixable (review)');
      console.log(`          ${tag}: ${v.fix.description}`);
    }
  }
  console.log(`          ${c(C.grey, v.ruleId)}`);
}

function printHuman(summary: RunSummary, opts: Options): void {
  let suppressed = 0;
  let hiddenInfo = 0;

  for (const file of summary.files) {
    if (file.violations.length === 0) continue;
    // Info findings are things worth knowing, not things to do today. Listed by default
    // they were 60% of a real run and pushed the errors off the top of the screen.
    const printable = opts.all ? file.violations : file.violations.filter((v) => v.severity !== 'info');
    if (printable.length === 0) {
      hiddenInfo += file.violations.length;
      continue;
    }
    console.log(`\n${c(C.bold, file.file)}`);

    const shown = new Map<string, number>();
    const held = new Map<string, number>();
    for (const v of file.violations) {
      if (!opts.all && v.severity === 'info') {
        hiddenInfo++;
        continue;
      }
      const seen = shown.get(v.ruleId) ?? 0;
      if (!opts.all && seen >= PER_RULE_PER_FILE) {
        held.set(v.ruleId, (held.get(v.ruleId) ?? 0) + 1);
        suppressed++;
        continue;
      }
      shown.set(v.ruleId, seen + 1);
      printViolation(v, opts);
    }
    for (const [ruleId, n] of held) {
      console.log(`  ${c(C.grey, `… and ${plural(n, 'more ' + ruleId)} in this file`)}`);
    }
  }

  const t = summary.totals;
  const filesWithFindings = summary.files.filter((f) => f.violations.length > 0);
  const suppressedByComment = summary.files.reduce((n, f) => n + (f.suppressed ?? 0), 0);

  // A suppression that no longer matches anything has outlived the problem it was written
  // for. Reporting it is the only thing that stops them accumulating until nobody knows
  // which are load-bearing.
  const stale = summary.files.flatMap((f) =>
    (f.unusedSuppressions ?? []).map((line) => `${f.file}:${line}`),
  );
  if (stale.length > 0) {
    console.log('');
    for (const where of stale.slice(0, 20)) {
      console.log(c(C.yellow, `unused a11yfix-disable at ${where}`));
    }
    if (stale.length > 20) console.log(c(C.grey, `  …and ${stale.length - 20} more`));
  }
  console.log('');
  if (t.violations === 0) {
    console.log(c(C.green, 'No violations found in the checks this tool can perform.'));
  } else {
    console.log(
      `${c(C.bold, plural(t.violations, 'finding'))}  ` +
        `(${c(C.red, plural(t.errors, 'error'))}, ${c(C.yellow, plural(t.warnings, 'warning'))}` +
        // Info findings are counted here so the parts add up to the total. A summary
        // whose numbers do not reconcile is the first thing a sceptical reader notices.
        `${t.info > 0 ? `, ${c(C.blue, `${t.info} info`)}` : ''})  ` +
        `across ${plural(filesWithFindings.length, 'file')}`,
    );
    console.log(
      c(C.grey, `${t.automatic} fixable automatically, ${t.review} fixable with review, ${t.manual} need a person.`),
    );

    // The shape of a report is information in itself: three rules accounting for
    // everything usually means one habit to change, not three hundred bugs to fix.
    if (summary.byRule.length > 1) {
      console.log('');
      for (const { ruleId, count } of summary.byRule.slice(0, 5)) {
        const rule = ALL_RULES.find((r) => r.id === ruleId);
        const share = Math.round((count / t.violations) * 100);
        console.log(
          `  ${c(C.grey, String(count).padStart(5))}  ${ruleId.padEnd(14)} ` +
            `${c(C.dim, `${String(share).padStart(3)}%`)}  ${rule?.title ?? ''}`,
        );
      }
      if (summary.byRule.length > 5) {
        console.log(c(C.grey, `  ${String(summary.byRule.length - 5).padStart(5)}  other rules`));
      }
    }

    // One file dominating a run is nearly always vendored or generated code, and saying
    // so is more useful than letting the reader scroll to the same conclusion.
    const worst = [...filesWithFindings].sort((a, b) => b.violations.length - a.violations.length)[0];
    if (worst !== undefined && worst.violations.length > t.violations / 2 && filesWithFindings.length > 1) {
      console.log(
        c(C.yellow, `\n${worst.violations.length} of those ${t.violations} findings are in one file: ${worst.file}`) +
          c(C.grey, '\nIf it is vendored or generated, exclude it before reading the rest.'),
      );
    }

    if (suppressedByComment > 0) {
      console.log(
        c(C.grey, `\n${plural(suppressedByComment, 'finding')} hidden by a11yfix-disable comments in the source.`),
      );
    }
    if (hiddenInfo > 0) {
      console.log(
        c(C.grey, `\n${plural(hiddenInfo, 'info finding')} not listed. Use --all to see them.`),
      );
    }
    if (suppressed > 0) {
      console.log(
        c(C.grey, `\n${plural(suppressed, 'repeated finding')} folded into the counts above. Use --all to list them.`),
      );
    }
  }

  if (opts.fix) {
    console.log(c(C.green, `${plural(t.fixed, 'fix', 'fixes')} written.`));
    for (const f of opts.writeFailures ?? []) {
      console.log(c(C.red, `could not write ${f.file}: ${f.reason}`));
    }
  } else if (t.automatic + t.review > 0) {
    console.log(c(C.grey, 'Run with --fix to apply, or --diff to preview.'));
  }

  // Stating coverage on every run is deliberate. Automated testing reaches roughly a
  // third of WCAG's success criteria, and a tool that lets a team believe otherwise
  // does more harm than one that finds less and says so.
  console.log(
    c(C.dim, '\nAutomated checks cover a minority of WCAG success criteria. A clean run is not a\n' +
      'conformance claim: keyboard flows, focus order, meaningful alt text and screen-reader\n' +
      'behaviour still need a human. See docs/coverage.md.'),
  );
}

function printRules(): void {
  console.log(c(C.bold, `a11yfix ${VERSION} — ${ALL_RULES.length} rules\n`));
  const sorted = [...ALL_RULES].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const r of sorted) {
    const wcag = r.wcag.length > 0 ? ` (WCAG ${r.wcag.join(', ')})` : '';
    console.log(`${c(C.bold, r.id.padEnd(16))} ${r.title}${c(C.grey, wcag)}`);
    console.log(`${' '.repeat(17)}${c(C.dim, r.summary)}`);
  }
}

const HELP = `a11yfix ${VERSION} — fix accessibility violations in source code

USAGE
  a11yfix [paths...] [options]

OPTIONS
  --fix               Write automatic fixes to disk
  --include-review    With --fix, also apply fixes that want a human glance
  --diff              Print a unified diff instead of writing files
  --level A|AA|AAA    Conformance target (default: AA)
  --json              Machine-readable output
  --quiet, -q         One line per finding
  --all               List info findings and repeats that are folded by default
  --ignore GLOB       Skip paths matching GLOB (repeatable)
  --disable IDS       Turn off rules, comma-separated
  --baseline [PATH]   Report only findings absent from the baseline
  --baseline-write    Record current findings as the baseline and exit
  --report [PATH]     Write a standalone HTML audit report (default a11yfix-report.html)
  --rules             List every rule and exit
  --max-files N       Safety limit on files scanned (default: 5000)
  --version, -v
  --help, -h

ADOPTING ON AN EXISTING PROJECT
  a11yfix . --baseline-write     # record what is already there, commit the file
  a11yfix . --baseline           # in CI: fail only on findings that are new

  Findings are matched by rule, file and the shape of the code, not by line
  number, so unrelated edits do not make an old finding look new.

CONFIGURATION
  .a11yfixrc.json in this directory or any ancestor, or an "a11yfix" key in
  package.json. A command-line flag always wins over the file.

  {
    "level": "AA",
    "ignore": ["public/**", "**/*.stories.tsx"],
    "rules": { "A11Y-LINK-007": "off" }
  }

EXIT CODES
  0  no errors found
  1  at least one error-severity finding, or a file --fix could not write
  2  bad usage, or a configuration file that could not be read

A11yFix reports what it can prove from source and refuses to guess. It will never
invent alt text, link text or a language code, because a plausible-sounding wrong
answer is worse for a disabled user than a missing one.
`;

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }
  if (opts.listRules) {
    printRules();
    return 0;
  }

  let config;
  try {
    config = await loadConfig(process.cwd());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const configDir = config.source === undefined ? process.cwd() : dirname(config.source.split(' ')[0] as string);
  // A flag beats a file. Someone typing --level AAA has said what they want more
  // recently than whoever committed the config.
  if (!opts.levelFromFlag && config.level !== undefined) opts.level = config.level;
  const ignore = [...(config.ignore ?? []), ...opts.ignore];
  const disabled = new Set<string>(opts.disable);
  for (const [id, setting] of Object.entries(config.rules ?? {})) {
    if (setting === 'off') disabled.add(id);
  }

  const collected: string[] = [];
  for (const p of opts.paths) {
    collected.push(...(await collectFiles(resolve(p), opts.maxFiles - collected.length)));
  }
  const files = collected.filter((f) => !isIgnored(f, ignore, configDir));
  const ignoredCount = collected.length - files.length;

  if (files.length === 0) {
    console.error(
      collected.length === 0
        ? 'No files to check. Supported: .html .jsx .tsx .vue .svelte .astro .css'
        : `All ${collected.length} matching files were excluded by an ignore pattern.`,
    );
    return 2;
  }

  // Stylesheets carry the package they belong to, so a `body { background: red }` in one
  // application's test fixture cannot colour a page in a different package. Scopes are
  // expressed relative to the working directory because that is how the paths handed to
  // analyseSource are expressed, and the two have to be comparable. A package root at or
  // above the working directory encloses the whole scan, so it becomes the empty scope,
  // which applies everywhere.
  const cwd = process.cwd();
  const toScanPath = (abs: string): string => {
    const r = relative(cwd, abs).split(sep).join('/');
    return r === '' || r.startsWith('..') ? '' : r;
  };
  const sheets: StylesheetSource[] = [];
  const packageRoots = new Map<string, string>();
  for (const f of files) {
    if (kindOf(f) !== 'css') continue;
    try {
      sheets.push({
        file: toScanPath(f),
        content: await readFile(f, 'utf8'),
        scope: toScanPath(await packageRootOf(f, packageRoots)),
      });
    } catch {
      /* colours from an unreadable sheet simply stay undetermined */
    }
  }

  const threshold: FixSafety | null = opts.fix || opts.diff ? (opts.includeReview ? 'review' : 'automatic') : null;

  const results = [];
  for (const f of files) {
    if (kindOf(f) === 'css') continue;
    let source: string;
    try {
      source = await readFile(f, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(cwd, f).split(sep).join('/');
    const r = analyseSource(rel, source, {
      rules: ALL_RULES,
      level: opts.level,
      stylesheets: sheets,
      fixThreshold: threshold,
      disabled,
    });
    results.push({ ...r, absolute: f, source });
  }

  const baselinePath = opts.baseline ?? DEFAULT_BASELINE;
  let baselineNote: string | undefined;

  if (opts.baselineWrite) {
    const found = results.flatMap((r) => r.violations);
    // Stamped with the run's own clock rather than left undated: a baseline whose age
    // nobody can see is one nobody questions.
    await writeBaseline(baselinePath, buildBaseline(found, new Date().toISOString()));
    console.log(
      c(C.green, `Baseline written to ${baselinePath}: ${found.length} existing findings.`),
    );
    console.log(
      c(C.grey, 'Commit it. Future runs with --baseline will report only what is new.'),
    );
    return 0;
  }

  if (opts.baselineEnabled) {
    let baseline;
    try {
      baseline = await readBaseline(baselinePath);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      console.error('Create one with: a11yfix . --baseline-write');
      return 2;
    }
    let matched = 0;
    let resolved = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i] as (typeof results)[number];
      const cmp = compareToBaseline(r.violations, baseline);
      // Each file is compared against the whole baseline, and the fingerprint carries the
      // file name, so entries cannot leak between files.
      results[i] = { ...r, violations: cmp.fresh };
      matched += cmp.matched;
    }
    const totalKnown = Object.values(baseline.entries).reduce((n, k) => n + k, 0);
    resolved = totalKnown - matched;
    baselineNote =
      `baseline ${baselinePath}: ${matched} known findings hidden` +
      (resolved > 0 ? `, ${resolved} since fixed — rerun --baseline-write to shrink it` : '');
  }

  const all = results.flatMap((r) => r.violations);
  const byRuleCount = new Map<string, number>();
  for (const v of all) byRuleCount.set(v.ruleId, (byRuleCount.get(v.ruleId) ?? 0) + 1);

  const fixCounts = countByFixClass(all);

  const summary: { -readonly [K in keyof RunSummary]: RunSummary[K] } = {
    files: results,
    totals: {
      violations: all.length,
      errors: all.filter((v) => v.severity === 'error').length,
      warnings: all.filter((v) => v.severity === 'warning').length,
      info: all.filter((v) => v.severity === 'info').length,
      automatic: fixCounts.automatic,
      review: fixCounts.review,
      manual: fixCounts.manual,
      fixed: results.reduce((n, r) => n + r.appliedFixes, 0),
    },
    byRule: [...byRuleCount.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
    durationMs: 0,
  };

  if (!opts.json && !opts.diff) {
    // A silent config is a support question waiting to happen: someone will wonder why
    // a rule they can see in --rules never fires.
    const notes: string[] = [];
    if (config.source !== undefined) notes.push(`config: ${relative(process.cwd(), config.source.split(' ')[0] as string) || config.source}`);
    if (ignoredCount > 0) notes.push(`${plural(ignoredCount, 'file')} ignored`);
    if (disabled.size > 0) notes.push(`${plural(disabled.size, 'rule')} off`);
    if (baselineNote !== undefined) notes.push(baselineNote);
    if (notes.length > 0) console.log(c(C.grey, notes.join('  ·  ')));
  }

  if (opts.diff) {
    let any = false;
    for (const r of results) {
      if (r.fixedSource === undefined || r.fixedSource === r.source) continue;
      process.stdout.write(unifiedDiff(r.file, r.source, r.fixedSource));
      any = true;
    }
    if (!any) console.error('No fixable violations found.');
    return summary.totals.errors > 0 ? 1 : 0;
  }

  // Writing is the only thing this tool does that a user cannot undo by closing the
  // terminal, so a failure part-way through has to be reported rather than thrown. An
  // unhandled rejection here would leave some files rewritten, some not, and a stack
  // trace instead of a list of which was which.
  const writeFailures: { file: string; reason: string }[] = [];
  if (opts.fix) {
    for (const r of results) {
      if (r.fixedSource === undefined || r.fixedSource === r.source) continue;
      try {
        await writeFile(r.absolute, r.fixedSource, 'utf8');
      } catch (err) {
        writeFailures.push({
          file: r.file,
          reason: err instanceof Error ? err.message : String(err),
        });
        // The findings for this file were counted as fixed when the edits were applied
        // in memory; on disk nothing changed, and the summary must say so.
        summary.totals = { ...summary.totals, fixed: summary.totals.fixed - r.appliedFixes };
      }
    }
  }

  if (opts.report !== undefined) {
    const html = renderReport(summary, {
      subject: reportSubject(opts.paths),
      generatedAt: new Date().toISOString(),
      level: opts.level,
      toolVersion: VERSION,
      includeInfo: opts.all,
      command: reportCommand(opts.paths),
    });
    try {
      await writeFile(opts.report, html, 'utf8');
      if (!opts.json && !opts.quiet) {
        console.log(c(C.green, `Report written to ${opts.report}`));
      }
    } catch (err) {
      console.error(
        `Could not write ${opts.report}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }
  }

  if (opts.json) {
    const json = {
      version: VERSION,
      totals: summary.totals,
      byRule: summary.byRule,
      suppressed: results.reduce((n, r) => n + (r.suppressed ?? 0), 0),
      files: results.map((r) => ({
        suppressed: r.suppressed ?? 0,
        unusedSuppressions: r.unusedSuppressions ?? [],
        file: r.file,
        kind: r.kind,
        appliedFixes: r.appliedFixes,
        skippedFixes: r.skippedFixes,
        violations: r.violations,
      })),
    };
    console.log(JSON.stringify(json, null, 2));
  } else {
    printHuman(summary, { ...opts, writeFailures });
  }

  // A failed write is a failed run even if the findings themselves were only warnings:
  // the user asked for files to change and some did not.
  if (writeFailures.length > 0) return 1;
  return summary.totals.errors > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('a11yfix failed:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
