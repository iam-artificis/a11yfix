/**
 * WCAG 2.2 success criteria at levels A and AA.
 *
 * This table lives in the source rather than in the documentation generator because two
 * things need it: `docs/coverage.md`, which states what the tool can and cannot reach,
 * and the audit report, which names the criterion a finding belongs to. Two copies of a
 * list like this drift, and the copy that drifts is always the one a reader is holding.
 *
 * `reach` records whether a static source analyser can say anything useful about the
 * criterion at all. It is a property of the technique, not of how many rules happen to
 * exist today: no future rule will let a file on disk report whether a video's audio
 * description is accurate.
 */

export type Reach = 'partial' | 'human';

export interface Criterion {
  readonly sc: string;
  readonly level: 'A' | 'AA' | 'AAA';
  readonly name: string;
  readonly reach: Reach;
}

export const CRITERIA: readonly Criterion[] = [
  { sc: '1.1.1', level: 'A', name: 'Non-text Content', reach: 'partial' },
  { sc: '1.2.1', level: 'A', name: 'Audio-only and Video-only (Prerecorded)', reach: 'partial' },
  { sc: '1.2.2', level: 'A', name: 'Captions (Prerecorded)', reach: 'partial' },
  { sc: '1.2.3', level: 'A', name: 'Audio Description or Media Alternative (Prerecorded)', reach: 'human' },
  { sc: '1.2.4', level: 'AA', name: 'Captions (Live)', reach: 'human' },
  { sc: '1.2.5', level: 'AA', name: 'Audio Description (Prerecorded)', reach: 'human' },
  { sc: '1.3.1', level: 'A', name: 'Info and Relationships', reach: 'partial' },
  { sc: '1.3.2', level: 'A', name: 'Meaningful Sequence', reach: 'human' },
  { sc: '1.3.3', level: 'A', name: 'Sensory Characteristics', reach: 'human' },
  { sc: '1.3.4', level: 'AA', name: 'Orientation', reach: 'human' },
  { sc: '1.3.5', level: 'AA', name: 'Identify Input Purpose', reach: 'partial' },
  { sc: '1.4.1', level: 'A', name: 'Use of Color', reach: 'partial' },
  { sc: '1.4.2', level: 'A', name: 'Audio Control', reach: 'partial' },
  { sc: '1.4.3', level: 'AA', name: 'Contrast (Minimum)', reach: 'partial' },
  { sc: '1.4.4', level: 'AA', name: 'Resize Text', reach: 'partial' },
  { sc: '1.4.5', level: 'AA', name: 'Images of Text', reach: 'human' },
  { sc: '1.4.10', level: 'AA', name: 'Reflow', reach: 'human' },
  { sc: '1.4.11', level: 'AA', name: 'Non-text Contrast', reach: 'partial' },
  { sc: '1.4.12', level: 'AA', name: 'Text Spacing', reach: 'human' },
  { sc: '1.4.13', level: 'AA', name: 'Content on Hover or Focus', reach: 'human' },
  { sc: '2.1.1', level: 'A', name: 'Keyboard', reach: 'partial' },
  { sc: '2.1.2', level: 'A', name: 'No Keyboard Trap', reach: 'human' },
  { sc: '2.1.4', level: 'A', name: 'Character Key Shortcuts', reach: 'partial' },
  { sc: '2.2.1', level: 'A', name: 'Timing Adjustable', reach: 'human' },
  { sc: '2.2.2', level: 'A', name: 'Pause, Stop, Hide', reach: 'human' },
  { sc: '2.3.1', level: 'A', name: 'Three Flashes or Below Threshold', reach: 'human' },
  { sc: '2.4.1', level: 'A', name: 'Bypass Blocks', reach: 'partial' },
  { sc: '2.4.2', level: 'A', name: 'Page Titled', reach: 'partial' },
  { sc: '2.4.3', level: 'A', name: 'Focus Order', reach: 'partial' },
  { sc: '2.4.4', level: 'A', name: 'Link Purpose (In Context)', reach: 'partial' },
  { sc: '2.4.5', level: 'AA', name: 'Multiple Ways', reach: 'human' },
  { sc: '2.4.6', level: 'AA', name: 'Headings and Labels', reach: 'partial' },
  { sc: '2.4.7', level: 'AA', name: 'Focus Visible', reach: 'partial' },
  { sc: '2.4.11', level: 'AA', name: 'Focus Not Obscured (Minimum)', reach: 'human' },
  { sc: '2.5.1', level: 'A', name: 'Pointer Gestures', reach: 'human' },
  { sc: '2.5.2', level: 'A', name: 'Pointer Cancellation', reach: 'human' },
  { sc: '2.5.3', level: 'A', name: 'Label in Name', reach: 'partial' },
  { sc: '2.5.4', level: 'A', name: 'Motion Actuation', reach: 'human' },
  { sc: '2.5.7', level: 'AA', name: 'Dragging Movements', reach: 'human' },
  { sc: '2.5.8', level: 'AA', name: 'Target Size (Minimum)', reach: 'human' },
  { sc: '3.1.1', level: 'A', name: 'Language of Page', reach: 'partial' },
  { sc: '3.1.2', level: 'AA', name: 'Language of Parts', reach: 'human' },
  { sc: '3.2.1', level: 'A', name: 'On Focus', reach: 'human' },
  { sc: '3.2.2', level: 'A', name: 'On Input', reach: 'human' },
  { sc: '3.2.3', level: 'AA', name: 'Consistent Navigation', reach: 'human' },
  { sc: '3.2.4', level: 'AA', name: 'Consistent Identification', reach: 'human' },
  { sc: '3.2.6', level: 'A', name: 'Consistent Help', reach: 'human' },
  { sc: '3.3.1', level: 'A', name: 'Error Identification', reach: 'human' },
  { sc: '3.3.2', level: 'A', name: 'Labels or Instructions', reach: 'partial' },
  { sc: '3.3.3', level: 'AA', name: 'Error Suggestion', reach: 'human' },
  { sc: '3.3.4', level: 'AA', name: 'Error Prevention (Legal, Financial, Data)', reach: 'human' },
  { sc: '3.3.7', level: 'A', name: 'Redundant Entry', reach: 'human' },
  { sc: '3.3.8', level: 'AA', name: 'Accessible Authentication (Minimum)', reach: 'human' },
  { sc: '4.1.2', level: 'A', name: 'Name, Role, Value', reach: 'partial' },
  { sc: '4.1.3', level: 'AA', name: 'Status Messages', reach: 'human' },
];

/**
 * AAA criteria that a rule cites in passing.
 *
 * Deliberately not part of CRITERIA: that list is the denominator for the coverage
 * claim, and the claim is about A and AA. A rule may still reference a AAA criterion —
 * "click here" is a level A failure under 2.4.4 only when the surrounding text does not
 * supply the purpose, and it is always a 2.4.9 failure — and when it does, the report
 * needs a name and a link rather than a bare number.
 */
const ALSO_CITED: readonly Criterion[] = [
  { sc: '2.4.9', level: 'AAA', name: 'Link Purpose (Link Only)', reach: 'partial' },
  { sc: '3.2.5', level: 'AAA', name: 'Change on Request', reach: 'partial' },
];

const BY_SC = new Map([...CRITERIA, ...ALSO_CITED].map((c) => [c.sc, c]));

/** The criterion with this number, or undefined for one no rule here cites. */
export function criterion(sc: string): Criterion | undefined {
  return BY_SC.get(sc);
}

/** "1.4.3 Contrast (Minimum)", or just the number for a criterion not in the table. */
export function criterionLabel(sc: string): string {
  const c = BY_SC.get(sc);
  return c === undefined ? sc : `${sc} ${c.name}`;
}

/**
 * The W3C's own page for a criterion, for a report a client will want to check.
 *
 * The slug is the criterion name lowercased with every run of punctuation turned into a
 * hyphen — including the parenthetical, which is load-bearing: "Contrast (Minimum)" is
 * `contrast-minimum`, and dropping the bracket collapses 2.4.4 "Link Purpose (In
 * Context)" and 2.4.9 "Link Purpose (Link Only)" onto one URL, so at least one link in
 * every report pointed at the wrong criterion.
 */
export function criterionUrl(sc: string): string {
  const c = BY_SC.get(sc);
  if (c === undefined) return 'https://www.w3.org/TR/WCAG22/';
  const slug = c.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `https://www.w3.org/WAI/WCAG22/Understanding/${slug}`;
}
