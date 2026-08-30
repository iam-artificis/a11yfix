import type { Violation } from '../types.js';

/**
 * How much of a finding the tool can actually take off a person's hands.
 *
 * `Fix.safety` alone is not the answer, for two reasons that both bite in practice. A fix
 * can be marked `automatic` and still carry no edits — several rules build a fix object
 * to describe the change and then decline to make it. And a fix can be marked `review`
 * while carrying an `advisory`, which is the tool's way of saying "here is the shape of
 * the answer, but choosing it needs a person".
 *
 * Counted the naive way, those two cases make the summary line and the audit report
 * disagree with each other by a few findings — small enough to look like a rounding
 * error, and exactly the kind of discrepancy that makes a reader stop believing the rest
 * of the numbers. One definition, used everywhere.
 */
export type FixClass = 'automatic' | 'review' | 'manual';

export function fixClass(v: Violation): FixClass {
  const fix = v.fix;
  if (fix === undefined) return 'manual';
  if (fix.safety === 'manual' || fix.advisory !== undefined) return 'manual';
  if (fix.edits.length === 0) return 'manual';
  return fix.safety;
}

export function countByFixClass(violations: readonly Violation[]): Record<FixClass, number> {
  const out: Record<FixClass, number> = { automatic: 0, review: 0, manual: 0 };
  for (const v of violations) out[fixClass(v)]++;
  return out;
}
