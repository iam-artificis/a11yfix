import type { ParsedMarkup } from './parse/markup.js';
import type { Palette } from './design/palette.js';

/**
 * The contract for A11yFix.
 *
 * The central design decision is visible in `Fix.safety`. This tool writes to a
 * developer's source, so it is far more important that it never guesses than that it
 * fixes everything. A missing `lang` attribute has exactly one right answer and can be
 * written automatically. A missing `alt` does not — only a human who has seen the image
 * knows what it says — so we mark the spot and fail CI rather than inventing text.
 * Invented alt text is worse than none: it silently lies to a screen-reader user, and
 * every automated checker downstream then reports the page as fixed.
 */

/** WCAG conformance target. */
export type Level = 'A' | 'AA' | 'AAA';

export type Severity = 'error' | 'warning' | 'info';

/**
 * How much confidence we have that applying this fix is correct and complete.
 *
 * - `automatic`: one provably correct answer. Written by `--fix` without asking.
 * - `review`:    correct in the common case but context could change it. Written only
 *                with `--fix --include-review`, and always surfaced in the diff.
 * - `manual`:    requires human knowledge we do not have. We insert a marker or emit
 *                advice, never a silent guess.
 */
export type FixSafety = 'automatic' | 'review' | 'manual';

/** A single replacement of a source range. Offsets are byte positions in the file. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  /** Short description shown alongside the diff hunk. */
  readonly label: string;
}

export interface Fix {
  readonly safety: FixSafety;
  readonly edits: readonly Edit[];
  /** What the fix does, in one line, for the PR body. */
  readonly description: string;
  /**
   * Set when the tool deliberately declines to patch: the minimal correct change is
   * large enough that a human should choose it. Carries the suggestion anyway.
   */
  readonly advisory?: string;
}

export interface Violation {
  readonly ruleId: string;
  /** WCAG success criteria addressed, e.g. ["1.4.3"]. Empty for best-practice rules. */
  readonly wcag: readonly string[];
  readonly level: Level;
  readonly severity: Severity;
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  /** What is wrong, stated as an observation about this element. */
  readonly message: string;
  /** Why it matters to a person using assistive technology. Concrete, not generic. */
  readonly impact: string;
  /** The offending source, trimmed for display. */
  readonly excerpt: string;
  readonly fix?: Fix;
}

export interface RuleContext {
  readonly file: string;
  readonly source: string;
  readonly markup: ParsedMarkup;
  readonly level: Level;
  /**
   * Colours, font sizes and weights resolved from inline styles, Tailwind utilities and
   * simple stylesheet selectors. Returns nothing rather than guessing when a value is
   * not statically determinable.
   */
  readonly palette: Palette;
  /** Convenience: build a Violation with line/column filled in from an offset. */
  report(v: Omit<Violation, 'line' | 'column' | 'file' | 'excerpt'>): Violation;
}

export interface Rule {
  readonly id: string;
  readonly title: string;
  readonly wcag: readonly string[];
  readonly level: Level;
  readonly severity: Severity;
  /** One line, shown by `a11yfix rules`. */
  readonly summary: string;
  /** File kinds this rule understands. */
  readonly appliesTo: readonly FileKind[];
  run(ctx: RuleContext): Violation[];
}

export type FileKind = 'html' | 'jsx' | 'vue' | 'svelte' | 'css';

/** Result of processing one file. */
export interface FileResult {
  readonly file: string;
  readonly kind: FileKind;
  readonly violations: readonly Violation[];
  /** Source after applying the fixes selected by the run's safety threshold. */
  readonly fixedSource?: string;
  /** Findings hidden by an a11yfix-disable comment in this file. */
  readonly suppressed?: number;
  /** Suppression comments in this file that matched nothing. */
  readonly unusedSuppressions?: readonly number[];
  readonly appliedFixes: number;
  readonly skippedFixes: number;
}

export interface RunSummary {
  readonly files: readonly FileResult[];
  readonly totals: {
    readonly violations: number;
    readonly errors: number;
    readonly warnings: number;
    readonly info: number;
    readonly automatic: number;
    readonly review: number;
    readonly manual: number;
    readonly fixed: number;
  };
  /** Rule ids that produced at least one violation, most frequent first. */
  readonly byRule: readonly { readonly ruleId: string; readonly count: number }[];
  readonly durationMs: number;
}

/** Marker inserted where a human must supply text we refuse to invent. */
export const TODO_MARKER = 'A11YFIX-TODO';
