import type { Fix, RunSummary, Severity, Violation } from './types.js';
import { ALL_RULES } from './rules/index.js';
import { CRITERIA, criterion, criterionUrl } from './wcag.js';
import { countByFixClass, fixClass } from './fix/classify.js';

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

export interface ReportOptions {
  /** What was scanned: a project name, a directory, a URL. */
  readonly subject: string;
  /** ISO timestamp. Passed in rather than read from the clock so the output is testable. */
  readonly generatedAt: string;
  readonly level: 'A' | 'AA' | 'AAA';
  readonly toolVersion: string;
  /** Include info-severity findings. Off by default, as in the terminal. */
  readonly includeInfo?: boolean;
  /** Command that produced this, printed so the reader can reproduce it. */
  readonly command?: string;
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Findings for one rule, with the rule's own metadata attached. */
interface RuleGroup {
  readonly ruleId: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: Severity;
  readonly wcag: readonly string[];
  readonly violations: Violation[];
}

function group(violations: readonly Violation[]): RuleGroup[] {
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
      title: rule?.title ?? ruleId,
      summary: rule?.summary ?? '',
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

/** What each finding needs from a person, in the words a non-developer can act on. */
function remedy(v: Violation): { readonly kind: string; readonly text: string } {
  const kind = fixClass(v);
  if (kind === 'automatic') {
    return { kind: 'a11yfix can patch this', text: (v.fix as Fix).description };
  }
  if (kind === 'review') {
    return { kind: 'patch ready, needs a look', text: (v.fix as Fix).description };
  }
  const fix = v.fix;
  return {
    kind: 'needs a person',
    text:
      fix === undefined
        ? 'No safe automatic change exists for this one.'
        : (fix.advisory ?? fix.description),
  };
}

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
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
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
  const all = summary.files.flatMap((f) => f.violations);
  const shown = includeInfo ? all : all.filter((v) => v.severity !== 'info');
  const groups = group(shown);

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
  w(`<html lang="en"><head><meta charset="utf-8">`);
  w('<meta name="viewport" content="width=device-width, initial-scale=1">');
  w(`<title>Accessibility audit — ${escapeHtml(options.subject)}</title>`);
  w(`<style>${STYLE}</style>`);
  w('</head><body><div class="wrap">');

  w('<header>');
  w(`<h1>Accessibility audit: ${escapeHtml(options.subject)}</h1>`);
  w(
    `<p class="sub">${escapeHtml(date)} · WCAG 2.2 level ${escapeHtml(options.level)} · ` +
      `${plural(summary.files.length, 'file')} scanned · a11yfix ${escapeHtml(options.toolVersion)}</p>`,
  );
  w('</header>');

  w('<div class="cards">');
  w(`<div class="card error"><div class="n">${errors}</div><div class="l">Errors</div></div>`);
  w(
    `<div class="card warning"><div class="n">${warnings}</div><div class="l">Warnings</div></div>`,
  );
  w(
    `<div class="card"><div class="n">${automatable}</div><div class="l">Fixable by patch</div></div>`,
  );
  w(`<div class="card"><div class="n">${manual}</div><div class="l">Need a person</div></div>`);
  w('</div>');

  w('<h2>What this report is</h2>');
  if (shown.length === 0) {
    w(
      '<p>Every check this tool can perform came back clean across ' +
        `${plural(summary.files.length, 'file')}. That is a real result, and it is also a narrow one — read the next section before treating it as more than it is.</p>`,
    );
  } else {
    w(
      `<p>${plural(shown.length, 'finding')} across ${plural(filesWithFindings, 'file')}. ` +
        'Each one names the file, the line, and the exact source that triggered it, so every claim ' +
        'below can be checked in under a minute. Nothing here is inferred from a screenshot or a score.</p>',
    );
  }

  w('<div class="note">');
  w(
    '<p><strong>This is not a conformance statement, and a clean run would not be one either.</strong> ' +
      `A11yFix reads source code. It checks ${CRITERIA.filter((c) => c.reach === 'partial').length} ` +
      `of the ${CRITERIA.length} WCAG 2.2 A and AA success criteria, and none of them completely.</p>`,
  );
  w(
    '<p>It can prove an image has no <code>alt</code> attribute. It cannot judge whether an ' +
      '<code>alt</code> that is present describes the image. Keyboard order, focus behaviour, ' +
      'screen-reader announcements, error recovery and anything that depends on how the page ' +
      'behaves in a browser are outside what any source analyser can see. Those need a person, ' +
      'and this report does not stand in for one.</p>',
  );
  w('</div>');

  if (criterionRows.length > 0) {
    w('<h2>By success criterion</h2>');
    w(
      '<p>The same findings, grouped by the part of WCAG 2.2 they fall under. Each criterion ' +
        'links to the W3C’s own explanation.</p>',
    );
    w('<table><thead><tr><th>Criterion</th><th>Level</th><th class="num">Findings</th></tr></thead><tbody>');
    for (const c of criterionRows) {
      w(
        `<tr><td><a href="${escapeHtml(criterionUrl(c.sc))}">${escapeHtml(c.sc)} ${escapeHtml(c.name)}</a></td>` +
          `<td>${escapeHtml(c.level)}</td><td class="num">${perCriterion.get(c.sc) as number}</td></tr>`,
      );
    }
    w('</tbody></table>');
  }

  if (groups.length > 0) {
    w('<h2>Findings</h2>');
    w(
      '<p>Ordered by severity, then by how many places each problem occurs in — which is ' +
        'roughly the order they are worth fixing in, because a single wrong value in a shared ' +
        'component usually accounts for a whole block of them.</p>',
    );
  }

  // Instances per rule are capped. A report with four hundred copies of the same finding
  // is not more convincing than one with ten and an honest count of the rest; it is just
  // one nobody reads to the end of.
  const MAX_INSTANCES = 12;

  for (const g of groups) {
    w(`<section class="rule ${g.severity}">`);
    w('<div class="head">');
    w(
      `<h3><span class="tag ${g.severity}">${g.severity}</span> ${escapeHtml(g.title)} ` +
        `<span class="meta">(${plural(g.violations.length, 'occurrence')})</span></h3>`,
    );
    if (g.summary !== '') w(`<p class="sub">${escapeHtml(g.summary)}</p>`);
    const links = g.wcag.map((sc) => {
      const c = criterion(sc);
      const label = c === undefined ? sc : `${sc} ${c.name}`;
      return `<a href="${escapeHtml(criterionUrl(sc))}">${escapeHtml(label)}</a>`;
    });
    w(
      `<p class="meta">${escapeHtml(g.ruleId)}${links.length > 0 ? ' · WCAG ' + links.join(', ') : ''}</p>`,
    );
    w('</div>');

    for (const v of g.violations.slice(0, MAX_INSTANCES)) {
      const r = remedy(v);
      w('<div class="instance">');
      w(`<p class="where"><code>${escapeHtml(v.file)}</code> line ${v.line}</p>`);
      w(`<pre>${escapeHtml(v.excerpt)}</pre>`);
      w(`<p class="impact">${escapeHtml(v.impact)}</p>`);
      w(
        `<p class="remedy"><span class="kind">${escapeHtml(r.kind)}:</span> ${escapeHtml(r.text)}</p>`,
      );
      w('</div>');
    }
    if (g.violations.length > MAX_INSTANCES) {
      w(
        `<p class="more">${g.violations.length - MAX_INSTANCES} further ` +
          `${g.violations.length - MAX_INSTANCES === 1 ? 'occurrence is' : 'occurrences are'} ` +
          'not listed here. The full set is in the JSON output.</p>',
      );
    }
    w('</section>');
  }

  if (!includeInfo) {
    const hidden = all.length - shown.length;
    if (hidden > 0) {
      w(
        `<p class="sub">${plural(hidden, 'informational finding')} not shown. ` +
          'These are conventions and hints rather than barriers; run with <code>--all</code> to include them.</p>',
      );
    }
  }

  w('<footer>');
  w(
    `<p>Generated by a11yfix ${escapeHtml(options.toolVersion)} on ${escapeHtml(date)}` +
      (options.command !== undefined
        ? ` — reproduce with <code>${escapeHtml(options.command)}</code>`
        : '') +
      '.</p>',
  );
  w(
    '<p>A11yFix does not invent alternative text, link text or language codes, and does not ' +
      'claim conformance. Where a correct answer requires knowing what something means, it says so ' +
      'and stops.</p>',
  );
  w('</footer>');

  w('</div></body></html>');
  return out.join('\n') + '\n';
}
