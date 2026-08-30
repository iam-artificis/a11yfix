import { writeFileSync } from 'node:fs';
import { ALL_RULES } from '../dist/rules/index.js';
import { CRITERIA } from '../dist/wcag.js';

/**
 * Generate docs/coverage.md from the rule set.
 *
 * Generated rather than written by hand so the claim can never drift from the code. A
 * coverage document that overstates what a tool checks is the specific failure that got
 * the accessibility-overlay industry into trouble, and the only defence is making the
 * document a function of the rules.
 */


const covered = new Map();
for (const rule of ALL_RULES) {
  for (const sc of rule.wcag) {
    if (!covered.has(sc)) covered.set(sc, []);
    covered.get(sc).push(rule);
  }
}

const rows = CRITERIA.map(({ sc, level, name, reach }) => {
  const rules = covered.get(sc) ?? [];
  const status = rules.length === 0 ? 'not checked' : reach === 'human' ? 'not checked' : 'partial';
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
