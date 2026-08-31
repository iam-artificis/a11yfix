/**
 * The shape both languages fill in.
 *
 * Written as an interface rather than inferred from the English so that adding a string
 * fails the build in the language that is missing it, instead of quietly falling back and
 * shipping a half-translated report to a client.
 */
export interface UiStrings {
  /**
   * Where the "why it matters" sentence goes.
   *
   * English composes it per finding and can name the file inside it, so it belongs next
   * to each occurrence. Russian has one sentence per rule, and printing the same
   * paragraph eight times under eight instances of one rule reads as padding — so it
   * goes once, in the rule's heading.
   */
  readonly impactPlacement: 'group' | 'instance';
  readonly htmlLang: string;
  readonly titlePrefix: string;
  subject(name: string): string;
  subline(date: string, level: string, files: number, version: string): string;
  readonly cardErrors: string;
  readonly cardWarnings: string;
  readonly cardFixable: string;
  readonly cardManual: string;
  readonly whatThisIs: string;
  clean(files: number): string;
  found(findings: number, files: number): string;
  readonly caveatHead: string;
  caveatBody(partial: number, total: number): string;
  /** Contains our own <code> tags, so it is written into the page unescaped. */
  readonly caveatBody2: string;
  /**
   * Extra caveat for a scan of a live URL rather than a project.
   *
   * A reader who is handed this cannot tell from the findings whether the page was read
   * from a repository or fetched over HTTP, and the difference decides what the absence
   * of a finding means: no script ran, so anything the browser would have built is not
   * in what was checked.
   */
  fetchedNote(urls: string): string;
  readonly byCriterion: string;
  readonly byCriterionIntro: string;
  /**
   * The criterion as this language names it.
   *
   * English uses the W3C's title. Russian uses ГОСТ Р 52872-2019's, which is the wording
   * that appears in the contract the reader is holding — the numbering is identical
   * because the standard was written from WCAG 2.1 and kept it.
   */
  criterionName(sc: string, english: string): string;
  /** Conformance level as this language writes it — 'AA' in Latin, 'АА' in Cyrillic. */
  criterionLevel(level: string): string;
  /** What standard the criterion column cites. */
  readonly criterionPrefix: string;
  /** Provenance for the criterion names. Empty where there is nothing to explain. */
  readonly criterionNote: string;
  readonly colCriterion: string;
  readonly colLevel: string;
  readonly colFindings: string;
  readonly findings: string;
  readonly findingsIntro: string;
  readonly line: string;
  /** Contains our own <code> tags. */
  more(n: number): string;
  /** Contains our own <code> tags; the count is escaped by the caller. */
  hidden(n: string): string;
  /** The severity badge on a rule heading: error / warning / info. */
  severity(kind: 'error' | 'warning' | 'info'): string;
  readonly kindAutomatic: string;
  readonly kindReview: string;
  readonly kindManual: string;
  generated(version: string, date: string): string;
  /** Contains our own <code> tags; the command is escaped by the caller. */
  reproduce(command: string): string;
  readonly footerPromise: string;
}

/** Per-rule text for a language that does not compose sentences per finding. */
export interface RuleText {
  readonly title: string;
  readonly summary: string;
  /** Why it matters to someone using assistive technology. */
  readonly impact: string;
  /** What the patch does, where one is offered. */
  readonly patch?: string;
  /** What a person has to do, where no patch can be offered. */
  readonly manual: string;
}
