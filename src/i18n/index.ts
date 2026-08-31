import type { Fix, Violation } from '../types.js';
import { ALL_RULES } from '../rules/index.js';
import { fixClass } from '../fix/classify.js';
import type { UiStrings } from './types.js';
import { FILE, FINDING, INFO_FINDING, RULE_TEXT_RU, UI_RU, pluralRu } from './ru.js';

/**
 * Language for the client-facing report.
 *
 * Only the report is translated. The terminal output stays in English: it is read by the
 * person who ran the command, who reads English compiler errors all day, and translating
 * it would double the surface that has to stay true without helping anybody. The report
 * goes to whoever commissioned the work — a procurement officer, a designer, a lawyer —
 * and in the market where ГОСТ Р 52872-2019 is written into a contract, that person may
 * not read English at all.
 *
 * The two languages resolve the same five things, and differ in one respect that matters:
 * English composes the per-finding text from the violation, so it can name the file
 * inside the sentence; Russian uses a fixed sentence per rule, because assembling Russian
 * prose from fragments produces something that reads as machine output, which is the last
 * impression a paid deliverable should give. The quoted source line carries the specifics
 * in both.
 */

export type Lang = 'en' | 'ru';

export interface Strings {
  readonly htmlLang: string;
  readonly ui: UiStrings;
  ruleTitle(ruleId: string): string;
  ruleSummary(ruleId: string): string;
  impact(v: Violation): string;
  remedy(v: Violation): { readonly kind: string; readonly text: string };
  count(n: number, kind: 'finding' | 'file' | 'occurrence' | 'infoFinding'): string;
}

const META = new Map(ALL_RULES.map((r) => [r.id, r]));

function pluralEn(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The concrete change a patch makes, as code rather than as a sentence.
 *
 * `raise contrast: text-gray-400 -> text-gray-600` needs no translation and is the single
 * most persuasive line in the report: it is the thing the reader can check against their
 * own file in ten seconds. So the Russian report keeps it verbatim next to the Russian
 * explanation rather than dropping it.
 */
function editSummary(fix: Fix | undefined): string {
  if (fix === undefined || fix.edits.length === 0) return '';
  const swaps: string[] = [];
  for (const edit of fix.edits) {
    const m = /:\s*(\S+)\s*->\s*(\S+)\s*$/.exec(edit.label);
    if (m !== null) swaps.push(`${m[1] as string} → ${m[2] as string}`);
  }
  return swaps.join(', ');
}

const EN_UI: UiStrings = {
  impactPlacement: 'instance',
  htmlLang: 'en',
  titlePrefix: 'Accessibility audit',
  subject: (name) => `Accessibility audit: ${name}`,
  subline: (date, level, scanned, version, unit) =>
    `${date} · WCAG 2.2 level ${level} · ${pluralEn(scanned, unit)} scanned · a11yfix ${version}`,
  cardErrors: 'Errors',
  cardWarnings: 'Warnings',
  cardFixable: 'Fixable by patch',
  cardManual: 'Need a person',
  whatThisIs: 'What this report is',
  clean: (scanned, unit) =>
    `Every check this tool can perform came back clean across ${pluralEn(scanned, unit)}. That is a real ` +
    'result, and it is also a narrow one — read the next section before treating it as ' +
    'more than it is.',
  found: (findings, scanned, unit) =>
    `${pluralEn(findings, 'finding')} across ${pluralEn(scanned, unit)}. Each one names the ` +
    `${unit}, the line, and the exact source that triggered it, so every claim below can ` +
    'be checked in under a minute. Nothing here is inferred from a screenshot or a score.',
  caveatHead: 'This is not a conformance statement, and a clean run would not be one either.',
  caveatBody: (partial, total) =>
    `A11yFix reads source code. It checks ${partial} of the ${total} WCAG 2.2 A and AA ` +
    'success criteria, and none of them completely.',
  caveatBody2:
    'It can prove an image has no <code>alt</code> attribute. It cannot judge whether an ' +
    '<code>alt</code> that is present describes the image. Keyboard order, focus ' +
    'behaviour, screen-reader announcements, error recovery and anything that depends on ' +
    'how the page behaves in a browser are outside what any source analyser can see. ' +
    'Those need a person, and this report does not stand in for one.',
  fetchedNote: (pages) =>
    `This was read over HTTP — ${pluralEn(pages, 'page')}, listed below — and not from a ` +
    "project's source files. No script was run, so anything the page builds in the " +
    'browser was not part of what was checked, and no patch is offered: there is no file ' +
    'here to change.',
  pagesHeading: 'Pages checked',
  pagesIntro:
    'Every page this run read, worst first, so the list doubles as where to start. A page ' +
    'with no findings is a page where nothing this tool checks went wrong — not a page ' +
    'that is accessible.',
  colPage: 'Page',
  colErrors: 'Errors',
  colWarnings: 'Warnings',
  pageSparse: 'assembled in the browser',
  pagesSparseNote:
    'Rows marked “assembled in the browser” arrived nearly empty: the server sends a shell ' +
    'and the browser builds the rest. No script was run, so those counts describe the ' +
    'shell and say nothing about the page a visitor sees.',
  byCriterion: 'By success criterion',
  byCriterionIntro:
    'The same findings, grouped by the part of WCAG 2.2 they fall under. Each criterion ' +
    'links to the W3C’s own explanation.',
  criterionName: (sc, english) => `${sc} ${english}`,
  criterionLevel: (level) => level,
  criterionPrefix: 'WCAG',
  criterionNote: '',
  colCriterion: 'Criterion',
  colLevel: 'Level',
  colFindings: 'Findings',
  findings: 'Findings',
  findingsIntro:
    'Ordered by severity, then by how many places each problem occurs in — which is ' +
    'roughly the order they are worth fixing in, because a single wrong value in a shared ' +
    'component usually accounts for a whole block of them.',
  line: 'line',
  excerptNow: 'now',
  excerptAfter: 'after the change',
  more: (n) =>
    `${n} further ${n === 1 ? 'occurrence is' : 'occurrences are'} not listed here. Run ` +
    'with <code>--all</code> for a report that lists every one.',
  hidden: (n) =>
    `${n} not shown. These are conventions and hints rather than barriers; run with ` +
    '<code>--all</code> to include them.',
  severity: (kind) => kind,
  kindAutomatic: 'a11yfix can patch this',
  kindReview: 'patch ready, needs a look',
  kindManual: 'needs a person',
  generated: (version, date) => `Generated by a11yfix ${version} on ${date}`,
  reproduce: (command) => ` — reproduce with <code>${command}</code>`,
  footerPromise:
    'A11yFix does not invent alternative text, link text or language codes, and does not ' +
    'claim conformance. Where a correct answer requires knowing what something means, it ' +
    'says so and stops.',
};



const EN: Strings = {
  htmlLang: 'en',
  ui: EN_UI,
  ruleTitle: (id) => META.get(id)?.title ?? id,
  ruleSummary: (id) => META.get(id)?.summary ?? '',
  impact: (v) => v.impact,
  remedy(v) {
    const kind = fixClass(v);
    if (kind === 'automatic') return { kind: EN_UI.kindAutomatic, text: (v.fix as Fix).description };
    if (kind === 'review') return { kind: EN_UI.kindReview, text: (v.fix as Fix).description };
    const fix = v.fix;
    return {
      kind: EN_UI.kindManual,
      text:
        fix === undefined
          ? 'No safe automatic change exists for this one.'
          : (fix.advisory ?? fix.description),
    };
  },
  count(n, kind) {
    switch (kind) {
      case 'file':
        return pluralEn(n, 'file');
      case 'occurrence':
        return pluralEn(n, 'occurrence');
      case 'infoFinding':
        return pluralEn(n, 'informational finding');
      default:
        return pluralEn(n, 'finding');
    }
  },
};

const RU: Strings = {
  htmlLang: 'ru',
  ui: UI_RU,
  ruleTitle: (id) => RULE_TEXT_RU[id]?.title ?? EN.ruleTitle(id),
  ruleSummary: (id) => RULE_TEXT_RU[id]?.summary ?? EN.ruleSummary(id),
  impact: (v) => RULE_TEXT_RU[v.ruleId]?.impact ?? v.impact,
  remedy(v) {
    const kind = fixClass(v);
    const text = RULE_TEXT_RU[v.ruleId];
    if (text === undefined) return EN.remedy(v);
    if (kind === 'manual') {
      // A rule that declines to patch for more than one reason needs more than one
      // sentence, or it states one reason about all of them.
      const reason = v.fix?.reason;
      const chosen = (reason !== undefined ? text.manualByReason?.[reason] : undefined) ?? text.manual;
      return { kind: UI_RU.kindManual, text: chosen };
    }
    const swaps = editSummary(v.fix);
    const body = text.patch ?? text.manual;
    return {
      kind: kind === 'automatic' ? UI_RU.kindAutomatic : UI_RU.kindReview,
      text: swaps === '' ? body : `${body} Замена: ${swaps}.`,
    };
  },
  count(n, kind) {
    switch (kind) {
      case 'file':
        return pluralRu(n, FILE[0], FILE[1], FILE[2]);
      case 'occurrence':
        return pluralRu(n, 'вхождение', 'вхождения', 'вхождений');
      case 'infoFinding':
        return pluralRu(n, INFO_FINDING[0], INFO_FINDING[1], INFO_FINDING[2]);
      default:
        return pluralRu(n, FINDING[0], FINDING[1], FINDING[2]);
    }
  },
};

export function strings(lang: Lang): Strings {
  return lang === 'ru' ? RU : EN;
}
