import { writeFileSync } from 'node:fs';
import { ALL_RULES } from '../dist/rules/index.js';

/**
 * Generate docs/coverage.md from the rule set.
 *
 * Generated rather than written by hand so the claim can never drift from the code. A
 * coverage document that overstates what a tool checks is the specific failure that got
 * the accessibility-overlay industry into trouble, and the only defence is making the
 * document a function of the rules.
 */

/** WCAG 2.2 success criteria, with the ones no static source analyser can reach marked. */
const CRITERIA = [
  ['1.1.1', 'A', 'Non-text Content', 'partial'],
  ['1.2.1', 'A', 'Audio-only and Video-only (Prerecorded)', 'partial'],
  ['1.2.2', 'A', 'Captions (Prerecorded)', 'partial'],
  ['1.2.3', 'A', 'Audio Description or Media Alternative', 'human'],
  ['1.2.4', 'AA', 'Captions (Live)', 'human'],
  ['1.2.5', 'AA', 'Audio Description (Prerecorded)', 'human'],
  ['1.3.1', 'A', 'Info and Relationships', 'partial'],
  ['1.3.2', 'A', 'Meaningful Sequence', 'human'],
  ['1.3.3', 'A', 'Sensory Characteristics', 'human'],
  ['1.3.4', 'AA', 'Orientation', 'human'],
  ['1.3.5', 'AA', 'Identify Input Purpose', 'partial'],
  ['1.4.1', 'A', 'Use of Color', 'partial'],
  ['1.4.2', 'A', 'Audio Control', 'partial'],
  ['1.4.3', 'AA', 'Contrast (Minimum)', 'partial'],
  ['1.4.4', 'AA', 'Resize Text', 'partial'],
  ['1.4.5', 'AA', 'Images of Text', 'human'],
  ['1.4.10', 'AA', 'Reflow', 'human'],
  ['1.4.11', 'AA', 'Non-text Contrast', 'partial'],
  ['1.4.12', 'AA', 'Text Spacing', 'human'],
  ['1.4.13', 'AA', 'Content on Hover or Focus', 'human'],
  ['2.1.1', 'A', 'Keyboard', 'partial'],
  ['2.1.2', 'A', 'No Keyboard Trap', 'human'],
  ['2.1.4', 'A', 'Character Key Shortcuts', 'partial'],
  ['2.2.1', 'A', 'Timing Adjustable', 'human'],
  ['2.2.2', 'A', 'Pause, Stop, Hide', 'human'],
  ['2.3.1', 'A', 'Three Flashes or Below Threshold', 'human'],
  ['2.4.1', 'A', 'Bypass Blocks', 'partial'],
  ['2.4.2', 'A', 'Page Titled', 'partial'],
  ['2.4.3', 'A', 'Focus Order', 'partial'],
  ['2.4.4', 'A', 'Link Purpose (In Context)', 'partial'],
  ['2.4.5', 'AA', 'Multiple Ways', 'human'],
  ['2.4.6', 'AA', 'Headings and Labels', 'partial'],
  ['2.4.7', 'AA', 'Focus Visible', 'partial'],
  ['2.4.11', 'AA', 'Focus Not Obscured (Minimum)', 'human'],
  ['2.5.1', 'A', 'Pointer Gestures', 'human'],
  ['2.5.2', 'A', 'Pointer Cancellation', 'human'],
  ['2.5.3', 'A', 'Label in Name', 'partial'],
  ['2.5.4', 'A', 'Motion Actuation', 'human'],
  ['2.5.7', 'AA', 'Dragging Movements', 'human'],
  ['2.5.8', 'AA', 'Target Size (Minimum)', 'human'],
  ['3.1.1', 'A', 'Language of Page', 'partial'],
  ['3.1.2', 'AA', 'Language of Parts', 'human'],
  ['3.2.1', 'A', 'On Focus', 'human'],
  ['3.2.2', 'A', 'On Input', 'human'],
  ['3.2.3', 'AA', 'Consistent Navigation', 'human'],
  ['3.2.4', 'AA', 'Consistent Identification', 'human'],
  ['3.2.6', 'A', 'Consistent Help', 'human'],
  ['3.3.1', 'A', 'Error Identification', 'human'],
  ['3.3.2', 'A', 'Labels or Instructions', 'partial'],
  ['3.3.3', 'AA', 'Error Suggestion', 'human'],
  ['3.3.4', 'AA', 'Error Prevention (Legal, Financial, Data)', 'human'],
  ['3.3.7', 'A', 'Redundant Entry', 'human'],
  ['3.3.8', 'AA', 'Accessible Authentication (Minimum)', 'human'],
  ['4.1.2', 'A', 'Name, Role, Value', 'partial'],
  ['4.1.3', 'AA', 'Status Messages', 'human'],
];

const covered = new Map();
for (const rule of ALL_RULES) {
  for (const sc of rule.wcag) {
    if (!covered.has(sc)) covered.set(sc, []);
    covered.get(sc).push(rule);
  }
}

const rows = CRITERIA.map(([sc, level, name, kind]) => {
  const rules = covered.get(sc) ?? [];
  const status = rules.length === 0 ? 'not checked' : kind === 'human' ? 'not checked' : 'partial';
  return { sc, level, name, status, rules };
});

const partial = rows.filter((r) => r.status === 'partial');
const unchecked = rows.filter((r) => r.status !== 'partial');

const lines = [
  '# What A11yFix checks, and what it cannot',
  '',
  '> This file is generated from the rule set by `npm run docs`. It cannot drift from',
  '> the code, which is the point: a coverage claim that is written by hand eventually',
  '> describes a tool that no longer exists.',
  '',
  '## The short version',
  '',
  `A11yFix ships **${ALL_RULES.length} rules** touching **${partial.length} of the ${CRITERIA.length}**`,
  'WCAG 2.2 A and AA success criteria listed here.',
  '',
  '**No criterion is fully covered by automation, and this table says "partial" for every',
  'one it touches on purpose.** A rule can prove that an `<img>` has no `alt` attribute. It',
  'cannot prove that an `alt` which *is* present describes the image. The first is a',
  'machine question; the second is not, and no amount of engineering changes that.',
  '',
  'Passing every check in this tool is not conformance. It means the machine-checkable',
  'part is clean and the human review can start from a smaller pile.',
  '',
  '## Criteria this tool checks',
  '',
  '| SC | Level | Name | Rules |',
  '|---|---|---|---|',
  ...partial.map(
    (r) => `| ${r.sc} | ${r.level} | ${r.name} | ${r.rules.map((x) => x.id).join(', ')} |`,
  ),
  '',
  '## Criteria this tool does not check',
  '',
  'These need a person, a browser, or both. Nothing in A11yFix will ever report on them,',
  'so a clean run tells you nothing about this list.',
  '',
  '| SC | Level | Name |',
  '|---|---|---|',
  ...unchecked.map((r) => `| ${r.sc} | ${r.level} | ${r.name} |`),
  '',
  '## Why "partial" everywhere',
  '',
  'Three limits apply to every rule here.',
  '',
  '**Source is not a page.** A component file is a fragment. Whether two `id` attributes',
  'actually collide, whether a heading level really skips, and what colour an element ends',
  'up rendering all depend on how the pieces are composed at runtime. A11yFix reports what',
  'is provable from the file and stays quiet otherwise.',
  '',
  '**Static analysis cannot evaluate the cascade.** Colours behind a runtime expression, a',
  'media query, a container query or a theme switch are not resolved. Values written as',
  'literals, Tailwind utilities, CSS custom properties or `@theme` tokens are.',
  '',
  '**Meaning is not machine-readable.** Alternative text, link purpose, heading wording and',
  'language are all judgements about intent. The tool marks them and refuses to guess.',
  '',
  '## The full rule list',
  '',
  '| Rule | WCAG | Level | Title |',
  '|---|---|---|---|',
  ...[...ALL_RULES]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((r) => `| \`${r.id}\` | ${r.wcag.join(', ') || '—'} | ${r.level} | ${r.title} |`),
  '',
];

writeFileSync('docs/coverage.md', lines.join('\n'));
console.log(`docs/coverage.md written: ${ALL_RULES.length} rules, ${partial.length} criteria touched`);
