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
  readonly byCriterion: string;
  readonly byCriterionIntro: string;
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
