import type { Violation } from './types.js';

/**
 * In-file suppressions.
 *
 * Configuration turns a rule off everywhere; this turns it off in one place. Without it a
 * single justified exception — a decorative image that really is decorative, a link whose
 * text really is fine in context — forces a whole rule off across the repository, which
 * is how a checker stops finding the things it was installed for.
 *
 * The comment has to name the rule or apply to one line. There is deliberately no
 * "disable everything from here on": a blanket switch buried in the middle of a file is
 * indistinguishable from the tool being broken, and nobody ever finds it again.
 */

export interface Suppression {
  /** 1-based line the suppression applies to. */
  readonly line: number;
  /** Rule ids named, or empty for "every rule on that line". */
  readonly ruleIds: readonly string[];
  /** Whole file rather than a single line. */
  readonly whole: boolean;
  /** Where the comment itself is, so an unused one can be reported. */
  readonly commentLine: number;
}

// A rule id has to start with a letter. Without that the trailing `-->` of an HTML
// comment parses as one, and every bare `a11yfix-disable-next-line` quietly becomes a
// suppression for a rule named "--", which matches nothing and hides nothing.
const DIRECTIVE = /a11yfix-disable(-next-line|-line|-file)?((?:\s+[A-Za-z][A-Za-z0-9-]*,?)*)/g;

/** Read every suppression comment in a source file. */
export function findSuppressions(source: string): Suppression[] {
  const out: Suppression[] = [];
  // Line offsets once, so each match is a binary search rather than a rescan.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  DIRECTIVE.lastIndex = 0;
  for (const m of source.matchAll(DIRECTIVE)) {
    const kind = m[1] ?? '-next-line';
    const ruleIds = (m[2] ?? '')
      .split(/[\s,]+/)
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x !== '');
    const commentLine = lineOf(m.index ?? 0);
    if (kind === '-file') {
      out.push({ line: 0, ruleIds, whole: true, commentLine });
    } else if (kind === '-line') {
      out.push({ line: commentLine, ruleIds, whole: false, commentLine });
    } else {
      out.push({ line: commentLine + 1, ruleIds, whole: false, commentLine });
    }
  }
  return out;
}

export interface SuppressResult {
  readonly kept: Violation[];
  readonly suppressed: number;
  /** Suppression comments that matched nothing — usually a rule that has since been fixed. */
  readonly unused: readonly Suppression[];
}

/** Drop the violations a comment in the file asked to hide, and count them. */
export function applySuppressions(
  violations: readonly Violation[],
  suppressions: readonly Suppression[],
): SuppressResult {
  if (suppressions.length === 0) {
    return { kept: [...violations], suppressed: 0, unused: [] };
  }

  const used = new Set<Suppression>();
  const kept: Violation[] = [];
  for (const v of violations) {
    const hit = suppressions.find(
      (s) =>
        (s.whole || s.line === v.line) &&
        (s.ruleIds.length === 0 || s.ruleIds.includes(v.ruleId.toUpperCase())),
    );
    if (hit === undefined) {
      kept.push(v);
      continue;
    }
    used.add(hit);
  }

  return {
    kept,
    suppressed: violations.length - kept.length,
    unused: suppressions.filter((s) => !used.has(s)),
  };
}
