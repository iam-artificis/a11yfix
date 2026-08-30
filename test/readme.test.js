import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { CRITERIA } from '../dist/wcag.js';

/**
 * The README is the product. Four of the thirty findings in the pre-launch review were
 * the same defect in it: a mechanism described that the code does not have, or a number
 * that does not reconcile. Prose cannot be reviewed into correctness, so every claim
 * concrete enough to check is checked here instead.
 *
 * The headline is the sharpest case. `npx a11yfix src --diff` printed "No fixable
 * violations found." on the README's own demo file, because a preview inherited the
 * conservative threshold that exists to protect files it does not write to. Anyone who
 * tried the first command in the readme watched the tool do nothing.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(root, 'README.md'), 'utf8');

/** Run the CLI. A run with findings exits 1 by design; that is not a test failure. */
const runCli = (...args) => {
  try {
    return execFileSync(process.execPath, [join(root, 'dist/cli.js'), ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
};

test('the headline command produces the headline diff', () => {
  const fenced = /```diff\n([\s\S]*?)```/.exec(README);
  assert.ok(fenced, 'the README no longer shows a diff');

  const actual = runCli('demo/Card.tsx', '--diff');
  assert.notEqual(actual.trim(), '', 'the headline command printed nothing');

  // The changed lines only: the README omits the ---/+++ header, and the hunk header
  // carries line numbers that are not the claim being made.
  const changed = (text) =>
    text
      .split('\n')
      .filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---)/.test(l))
      .map((l) => l.trimEnd());

  assert.deepEqual(
    changed(actual),
    changed(fenced[1]),
    'the diff in the README is not the diff the command prints',
  );
});

test('the rule count in the README is the number of rules', () => {
  for (const m of README.matchAll(/(\d+)\s+rules?\b/gi)) {
    assert.equal(
      Number(m[1]),
      ALL_RULES.length,
      `README claims ${m[1]} rules; there are ${ALL_RULES.length}`,
    );
  }
});

test('the sample output in the README is the output', () => {
  // The block under "What a run looks like" is a screenshot in prose: the counts, the
  // ratio and the shade all have to be what the command prints today, or the first thing
  // a reader does — run it and compare — disagrees with the pitch.
  const shown = /\n```\ndemo\/Card\.tsx\n([\s\S]*?)```/.exec(README);
  assert.ok(shown, 'the README no longer shows a sample run');

  const actual = runCli('demo/Card.tsx');
  const claims = [
    '3 findings  (3 errors, 0 warnings)  across 1 file',
    '0 fixable automatically, 3 fixable with review, 0 need a person.',
  ];
  for (const line of claims) {
    assert.ok(shown[1].includes(line), `the README's sample no longer contains: ${line}`);
    assert.ok(actual.includes(line), `the command no longer prints: ${line}`);
  }

  // Every claim of the form "Replace X with Y, reaching N:1" has to appear verbatim.
  const swaps = [...shown[1].matchAll(/Replace \S+ with \S+, reaching [\d.]+:1\./g)];
  assert.ok(swaps.length > 0, 'the sample no longer quotes a ratio');
  for (const m of swaps) {
    assert.ok(actual.includes(m[0]), `the README shows "${m[0]}" and the command does not`);
  }
});

test('a marker is written only when asked for by name', () => {
  // The README says markers are opt-in. If that stops being true, --fix starts breaking
  // builds on purpose without having been asked to.
  const source = 'export const A = () => (<div><a href="/x"><span /></a></div>);';
  const review = analyseSource('A.tsx', source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: 'review',
  });
  assert.equal(review.fixedSource ?? source, source, '--include-review wrote a marker');
});

test('the README table and the field report agree', () => {
  // They did not: the README said 27 errors for tailwindcss.com where the field report
  // said 26, and only one of the two had been re-measured. Two hand-maintained copies of
  // the same measurement drift the moment anyone touches either — so the copies are
  // compared here instead of trusted.
  const rows = (text) => {
    const out = new Map();
    for (const line of text.split('\n')) {
      const m = /^\|\s*`([^`]+)`\s*\|(.+)\|\s*$/.exec(line);
      if (m === null) continue;
      const cells = m[2].split('|').map((c) => c.trim());
      const numbers = cells.filter((c) => /^\d+$/.test(c)).map(Number);
      if (numbers.length >= 3) out.set(m[1], numbers);
    }
    return out;
  };

  const readme = rows(README);
  const report = rows(readFileSync(join(root, 'docs/field-report.md'), 'utf8'));
  assert.ok(readme.size > 0, 'the README no longer has a results table');
  assert.ok(report.size > 0, 'the field report no longer has a results table');

  for (const [repo, cells] of readme) {
    const other = report.get(repo);
    assert.ok(other, `${repo} is in the README table and not in the field report`);
    // The README gives files/errors/warnings; the field report adds info and drops none.
    assert.deepEqual(
      cells.slice(0, 3),
      other.slice(0, 3),
      `${repo}: README says ${cells.slice(0, 3)}, the field report says ${other.slice(0, 3)}`,
    );
  }
});
