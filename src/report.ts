import type { RunSummary, Severity, Violation } from './types.js';
import { ALL_RULES } from './rules/index.js';
import { CRITERIA, criterion, criterionUrl } from './wcag.js';
import { countByFixClass } from './fix/classify.js';
import type { Lang, Strings } from './i18n/index.js';
import type { Unit } from './i18n/types.js';
import { strings } from './i18n/index.js';

/**
 * A standalone HTML audit report.
 *
 * The terminal output is for the person who ran the tool. This is for everyone else: the
 * designer who has to pick a new colour, the manager deciding whether to schedule the
 * work, the lawyer reading the file because the European Accessibility Act came into
 * force in June 2025 and somebody asked what the exposure is. None of them will run a
 * CLI, and a JSON dump tells them nothing.
 *
 * Two rules govern what goes in it.
 *
 * **Every claim is checkable.** Each finding carries the file, the line and the exact
 * source that triggered it. A report that says "37 issues" and nothing else is worth
 * nothing, because the reader cannot confirm a single one.
 *
 * **The limits are stated up front, not buried.** The section on what the tool cannot see
 * appears before the findings, not after. The accessibility-overlay industry was fined
 * for the opposite arrangement, and a report that implies conformance from a passing
 * automated scan is the same lie in a different font.
 *
 * The file is self-contained — no fonts, no scripts, no images. It has to survive being
 * emailed, opened offline, and printed.
 */

/** One page read over HTTP, as the report needs to describe it. */
export interface ScannedPage {
  readonly url: string;
  /** The name findings from this page are filed under, so rows can be matched to them. */
  readonly file: string;
  /** The served HTML was nearly empty: the page is assembled in the browser. */
  readonly sparse: boolean;
}

export interface ReportOptions {
  /** What was scanned: a project name, a directory, a URL. */
  readonly subject: string;
  /** ISO timestamp. Passed in rather than read from the clock so the output is testable. */
  readonly generatedAt: string;
  readonly level: 'A' | 'AA' | 'AAA';
  readonly toolVersion: string;
  /**
   * Include info-severity findings, and list every occurrence of a rule rather than the
   * first twelve. Off by default, as in the terminal: --all means "show me everything"
   * in both places.
   */
  readonly includeInfo?: boolean;
  /** Command that produced this, printed so the reader can reproduce it. */
  readonly command?: string;
  /**
   * The pages this run read over HTTP, if it read any.
   *
   * Two things depend on this. It changes what a clean result means — no script ran, so
   * the absence of a finding is the absence of a finding *in what the server sent*. And
   * it is the only place the reader can see what was actually covered: a whole-site audit
   * that does not say which pages it read is an invitation to assume it read all of them.
   */
  readonly fetched?: readonly ScannedPage[];
  /**
   * Language of the report. Defaults to English.
   *
   * Only the report is translated; the terminal stays English. See src/i18n/index.ts for
   * why, and for what the two languages do differently.
   */
  readonly lang?: Lang;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape for HTML text and attribute contexts alike.
 *
 * The input here is somebody else's source code, including whatever they wrote inside a
 * `<script>` tag. Producing a report that executes it would be a remarkable way to ship
 * an accessibility tool.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Findings for one rule, with the rule's own metadata attached. */
interface RuleGroup {
  readonly ruleId: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: Severity;
  readonly wcag: readonly string[];
  readonly violations: Violation[];
}

function group(violations: readonly Violation[], t: Strings): RuleGroup[] {
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byRule.get(v.ruleId);
    if (list === undefined) byRule.set(v.ruleId, [v]);
    else list.push(v);
  }

  const meta = new Map(ALL_RULES.map((r) => [r.id, r]));
  const groups: RuleGroup[] = [];
  for (const [ruleId, list] of byRule) {
    const rule = meta.get(ruleId);
    const first = list[0] as Violation;
    groups.push({
      ruleId,
      title: t.ruleTitle(ruleId),
      summary: t.ruleSummary(ruleId),
      severity: first.severity,
      wcag: rule?.wcag ?? first.wcag,
      violations: list.sort((a, b) =>
        a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
      ),
    });
  }

  // Worst first, then whichever affects the most places: the order somebody would work
  // through them in.
  return groups.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.violations.length - a.violations.length ||
      (a.ruleId < b.ruleId ? -1 : 1),
  );
}

// What each finding needs from a person, in the words a non-developer can act on, lives
// in src/i18n: it is one of the five things that differ between the two languages.

const STYLE = `
:root {
  --ink: #16181d;
  --muted: #5b616e;
  --line: #e2e5ea;
  --bg: #ffffff;
  --panel: #f7f8fa;
  --error: #a3161d;
  --error-bg: #fdf2f2;
  --warning: #8a5a00;
  --warning-bg: #fdf8ee;
  --ok: #1f6d33;
  --info: #24557a;
  --info-bg: #f1f6fa;
  --accent: #0b3d5c;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 1.5rem 5rem;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 52rem; margin: 0 auto; }
header { padding: 3rem 0 2rem; border-bottom: 2px solid var(--ink); }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -.01em; }
h2 { font-size: 1.3rem; margin: 2.75rem 0 .75rem; letter-spacing: -.01em; }
h3 { font-size: 1.05rem; margin: 0 0 .35rem; }
p { margin: 0 0 1rem; }
.sub { color: var(--muted); margin: 0; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.75rem 0 0; }
.card {
  flex: 1 1 8rem; border: 1px solid var(--line); border-radius: 8px;
  padding: .9rem 1rem; background: var(--panel);
}
.card .n { font-size: 1.7rem; font-weight: 650; line-height: 1.1; }
.card .l { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
.card.error .n { color: var(--error); }
.card.warning .n { color: var(--warning); }
.note {
  border-left: 3px solid var(--accent); background: var(--panel);
  padding: 1rem 1.25rem; margin: 1.5rem 0; border-radius: 0 6px 6px 0;
}
.note p:last-child { margin-bottom: 0; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; margin: 0 0 1rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.path { word-break: break-all; }
pre.was, pre.now { border-left: 3px solid var(--line); padding-left: .7rem; }
pre.was { margin-bottom: .3rem; }
pre.now { border-left-color: var(--ok); }
pre.now .lbl { color: var(--ok); }
pre .lbl {
  display: block; font-size: .68rem; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--muted); margin-bottom: .2rem;
}
.rule { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 1.25rem; overflow: hidden; break-inside: avoid; }
.rule > .head { padding: 1rem 1.25rem; border-bottom: 1px solid var(--line); }
.rule.error > .head { background: var(--error-bg); }
.rule.warning > .head { background: var(--warning-bg); }
.rule.info > .head { background: var(--info-bg); }
.tag {
  display: inline-block; font-size: .72rem; font-weight: 600; letter-spacing: .05em;
  text-transform: uppercase; padding: .12rem .45rem; border-radius: 4px; vertical-align: 2px;
}
.tag.error { color: var(--error); background: #fbdcdc; }
.tag.warning { color: var(--warning); background: #f7e9c9; }
.tag.info { color: var(--info); background: #dceaf5; }
.meta { color: var(--muted); font-size: .85rem; margin: .35rem 0 0; }
.meta a { color: var(--accent); }
.instance { padding: 1rem 1.25rem; border-top: 1px solid var(--line); }
.instance:first-of-type { border-top: 0; }
.where { font-size: .85rem; color: var(--muted); margin: 0 0 .5rem; }
.where code { color: var(--ink); }
code, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
pre {
  margin: 0 0 .75rem; padding: .7rem .85rem; background: var(--panel);
  border: 1px solid var(--line); border-radius: 6px;
  font-size: .82rem; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
}
.impact { margin: 0 0 .6rem; }
.remedy { font-size: .92rem; margin: 0; }
.remedy .kind { font-weight: 600; }
.more { color: var(--muted); font-size: .88rem; padding: .75rem 1.25rem; border-top: 1px solid var(--line); }
footer { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
footer code { color: var(--ink); }
@media print {
  body { padding: 0; font-size: 11pt; }
  .rule, .note { break-inside: avoid; }
  h2 { break-after: avoid; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: .75em; color: #666; }
}
`;

/**
 * Render the whole report.
 *
 * Deterministic: nothing here reads the clock, the filesystem or the environment, so two
 * runs over the same findings produce byte-identical output and the file can be diffed
 * or committed.
 */
export function renderReport(summary: RunSummary, options: ReportOptions): string {
  const includeInfo = options.includeInfo ?? false;
  const t = strings(options.lang ?? 'en');
  const all = summary.files.flatMap((f) => f.violations);
  const shown = includeInfo ? all : all.filter((v) => v.severity !== 'info');
  const groups = group(shown, t);

  const errors = shown.filter((v) => v.severity === 'error').length;
  const warnings = shown.filter((v) => v.severity === 'warning').length;
  const fixes = countByFixClass(shown);
  const manual = fixes.manual;
  const automatable = fixes.automatic + fixes.review;
  const filesWithFindings = new Set(shown.map((v) => v.file)).size;

  const date = options.generatedAt.slice(0, 10);

  // Findings per success criterion, so a reader can map the work onto the standard their
  // obligation is actually written in terms of.
  const perCriterion = new Map<string, number>();
  for (const v of shown) {
    for (const sc of v.wcag) perCriterion.set(sc, (perCriterion.get(sc) ?? 0) + 1);
  }
  const criterionRows = CRITERIA.filter((c) => perCriterion.has(c.sc)).sort(
    (a, b) => (perCriterion.get(b.sc) as number) - (perCriterion.get(a.sc) as number),
  );

  const out: string[] = [];
  const w = (line: string): void => {
    out.push(line);
  };

  w('<!doctype html>');
  w(`<html lang="${t.htmlLang}"><head><meta charset="utf-8">`);
  w('<meta name="viewport" content="width=device-width, initial-scale=1">');
  w(`<title>${escapeHtml(t.ui.titlePrefix)} — ${escapeHtml(options.subject)}</title>`);
  w(`<style>${STYLE}</style>`);
  w('</head><body><div class="wrap">');

  // A run that read URLs scanned pages, not files, and calling them files in a document
  // handed to the site's owner describes something they do not have and cannot check.
  const unit: Unit = (options.fetched ?? []).length > 0 ? 'page' : 'file';

  w('<header>');
  w(`<h1>${escapeHtml(t.ui.subject(options.subject))}</h1>`);
  w(
    `<p class="sub">${escapeHtml(
      t.ui.subline(date, options.level, summary.files.length, options.toolVersion, unit),
    )}</p>`,
  );
  w('</header>');

  w('<div class="cards">');
  const card = (n: number, label: string, cls = ''): string =>
    `<div class="card ${cls}"><div class="n">${n}</div><div class="l">${escapeHtml(label)}</div></div>`;
  w(card(errors, t.ui.cardErrors, 'error'));
  w(card(warnings, t.ui.cardWarnings, 'warning'));
  w(card(automatable, t.ui.cardFixable));
  w(card(manual, t.ui.cardManual));
  w('</div>');

  w(`<h2>${escapeHtml(t.ui.whatThisIs)}</h2>`);
  if (shown.length === 0) {
    w(`<p>${escapeHtml(t.ui.clean(summary.files.length, unit))}</p>`);
  } else {
    w(`<p>${escapeHtml(t.ui.found(shown.length, filesWithFindings, unit))}</p>`);
  }

  w('<div class="note">');
  w(
    `<p><strong>${escapeHtml(t.ui.caveatHead)}</strong> ` +
      escapeHtml(
        t.ui.caveatBody(CRITERIA.filter((c) => c.reach === 'partial').length, CRITERIA.length),
      ) +
      '</p>',
  );
  // caveatBody2 carries <code> tags, which are ours rather than the scanned source's.
  w(`<p>${t.ui.caveatBody2}</p>`);
  if (options.fetched !== undefined && options.fetched.length > 0) {
    w(`<p><strong>${escapeHtml(t.ui.fetchedNote(options.fetched.length))}</strong></p>`);
  }
  w('</div>');

  if (options.fetched !== undefined && options.fetched.length > 0) {
    // Counted from every violation, not from the ones shown: a page whose only findings
    // are info-severity has not been checked less than its neighbours, and showing it as
    // a zero next to a page with one warning would misdirect whoever reads this to decide
    // where to spend a week.
    const byFile = new Map<string, { errors: number; warnings: number; total: number }>();
    for (const f of summary.files) {
      const row = { errors: 0, warnings: 0, total: f.violations.length };
      for (const v of f.violations) {
        if (v.severity === 'error') row.errors++;
        else if (v.severity === 'warning') row.warnings++;
      }
      byFile.set(f.file, row);
    }
    const rows = options.fetched.map((page) => ({
      page,
      counts: byFile.get(page.file) ?? { errors: 0, warnings: 0, total: 0 },
    }));
    rows.sort(
      (a, b) =>
        b.counts.errors - a.counts.errors ||
        b.counts.warnings - a.counts.warnings ||
        b.counts.total - a.counts.total ||
        (a.page.url < b.page.url ? -1 : 1),
    );

    w(`<h2>${escapeHtml(t.ui.pagesHeading)}</h2>`);
    w(`<p>${escapeHtml(t.ui.pagesIntro)}</p>`);
    w(
      '<table><thead><tr>' +
        `<th>${escapeHtml(t.ui.colPage)}</th>` +
        `<th class="num">${escapeHtml(t.ui.colErrors)}</th>` +
        `<th class="num">${escapeHtml(t.ui.colWarnings)}</th>` +
        `<th class="num">${escapeHtml(t.ui.colFindings)}</th>` +
        '</tr></thead><tbody>',
    );
    for (const r of rows) {
      const mark = r.page.sparse
        ? ` <span class="tag warning">${escapeHtml(t.ui.pageSparse)}</span>`
        : '';
      w(
        `<tr><td class="path">${escapeHtml(r.page.url)}${mark}</td>` +
          `<td class="num">${r.counts.errors}</td>` +
          `<td class="num">${r.counts.warnings}</td>` +
          `<td class="num">${r.counts.total}</td></tr>`,
      );
    }
    w('</tbody></table>');
    if (rows.some((r) => r.page.sparse)) w(`<p class="sub">${escapeHtml(t.ui.pagesSparseNote)}</p>`);
  }

  if (criterionRows.length > 0) {
    w(`<h2>${escapeHtml(t.ui.byCriterion)}</h2>`);
    w(`<p>${escapeHtml(t.ui.byCriterionIntro)}</p>`);
    w(
      '<table><thead><tr>' +
        `<th>${escapeHtml(t.ui.colCriterion)}</th>` +
        `<th>${escapeHtml(t.ui.colLevel)}</th>` +
        `<th class="num">${escapeHtml(t.ui.colFindings)}</th>` +
        '</tr></thead><tbody>',
    );
    for (const c of criterionRows) {
      w(
        `<tr><td><a href="${escapeHtml(criterionUrl(c.sc))}">${escapeHtml(t.ui.criterionName(c.sc, c.name))}</a></td>` +
          `<td>${escapeHtml(t.ui.criterionLevel(c.level))}</td><td class="num">${perCriterion.get(c.sc) as number}</td></tr>`,
      );
    }
    w('</tbody></table>');
    if (t.ui.criterionNote !== '') w(`<p class="sub">${escapeHtml(t.ui.criterionNote)}</p>`);
  }

  if (groups.length > 0) {
    w(`<h2>${escapeHtml(t.ui.findings)}</h2>`);
    w(`<p>${escapeHtml(t.ui.findingsIntro)}</p>`);
  }

  // Instances per rule are capped by default. Four hundred copies of one finding is not
  // more convincing than twelve and an honest count of the rest; it is just a report
  // nobody reads to the end of. --all lifts the cap, because somebody being handed this
  // as a deliverable needs every occurrence, not a sample.
  const MAX_INSTANCES = includeInfo ? Number.POSITIVE_INFINITY : 12;

  for (const g of groups) {
    w(`<section class="rule ${g.severity}">`);
    w('<div class="head">');
    w(
      `<h3><span class="tag ${g.severity}">${escapeHtml(t.ui.severity(g.severity))}</span> ` +
        `${escapeHtml(g.title)} ` +
        `<span class="meta">(${escapeHtml(t.count(g.violations.length, 'occurrence'))})</span></h3>`,
    );
    if (g.summary !== '') w(`<p class="sub">${escapeHtml(g.summary)}</p>`);
    // One sentence per rule goes here; one sentence per finding goes with the finding.
    if (t.ui.impactPlacement === 'group') {
      w(`<p class="impact">${escapeHtml(t.impact(g.violations[0] as Violation))}</p>`);
    }
    const links = g.wcag.map((sc) => {
      const c = criterion(sc);
      const label = t.ui.criterionName(sc, c === undefined ? '' : c.name).trim();
      return `<a href="${escapeHtml(criterionUrl(sc))}">${escapeHtml(label)}</a>`;
    });
    w(
      `<p class="meta">${escapeHtml(g.ruleId)}` +
        (links.length > 0 ? ` · ${escapeHtml(t.ui.criterionPrefix)} ${links.join(', ')}` : '') +
        '</p>',
    );
    w('</div>');

    for (const v of g.violations.slice(0, MAX_INSTANCES)) {
      const r = t.remedy(v);
      w('<div class="instance">');
      w(
        `<p class="where"><code>${escapeHtml(v.file)}</code> ${escapeHtml(t.ui.line)} ${v.line}</p>`,
      );
      // Two blocks where the change is one the tool would really write, one where it is
      // not. The second block is the shortest honest answer to "what do I do about it",
      // and on a URL scan — where there is no patch to hand over — it is the only form
      // that answer can take. Where the change is a floor rather than a finish, the
      // remedy sentence immediately below says so; that is why the label reads "after the
      // change" and not "correct".
      if (v.excerptFixed === undefined) {
        w(`<pre>${escapeHtml(v.excerpt)}</pre>`);
      } else {
        w(`<pre class="was"><span class="lbl">${escapeHtml(t.ui.excerptNow)}</span>${escapeHtml(v.excerpt)}</pre>`);
        w(
          `<pre class="now"><span class="lbl">${escapeHtml(t.ui.excerptAfter)}</span>` +
            `${escapeHtml(v.excerptFixed)}</pre>`,
        );
      }
      if (t.ui.impactPlacement === 'instance') {
        w(`<p class="impact">${escapeHtml(t.impact(v))}</p>`);
      }
      w(
        `<p class="remedy"><span class="kind">${escapeHtml(r.kind)}:</span> ${escapeHtml(r.text)}</p>`,
      );
      w('</div>');
    }
    if (g.violations.length > MAX_INSTANCES) {
      const rest = g.violations.length - MAX_INSTANCES;
      // more() carries <code> tags of ours; rest is a number.
      w(`<p class="more">${t.ui.more(rest)}</p>`);
    }
    w('</section>');
  }

  if (!includeInfo) {
    const hidden = all.length - shown.length;
    if (hidden > 0) {
      w(`<p class="sub">${t.ui.hidden(escapeHtml(t.count(hidden, 'infoFinding')))}</p>`);
    }
  }

  w('<footer>');
  w(
    `<p>${escapeHtml(t.ui.generated(options.toolVersion, date))}` +
      (options.command !== undefined ? t.ui.reproduce(escapeHtml(options.command)) : '') +
      '.</p>',
  );
  w(`<p>${escapeHtml(t.ui.footerPromise)}</p>`);
  w('</footer>');

  w('</div></body></html>');
  return out.join('\n') + '\n';
}
