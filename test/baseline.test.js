import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import {
  buildBaseline,
  compareToBaseline,
  fingerprint,
  readBaseline,
  writeBaseline,
} from '../dist/baseline.js';

/**
 * A baseline is the feature that decides whether a team can adopt this at all: a real
 * application produced 1382 findings on its first run, and nobody fixes 1382 things
 * before merging the next feature. The property that has to hold is narrow — old
 * findings stay hidden through unrelated edits, genuinely new ones do not.
 */

const run = (file, source, opts = {}) =>
  analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: null, ...opts });

const NOW = '2026-01-01T00:00:00.000Z';

const withTempDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'a11yfix-baseline-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('a baseline hides exactly the findings it recorded', () => {
  const source = `<html lang="en"><head><title>T</title></head><body>
  <img src="a.png">
  <img src="b.png">
</body></html>`;
  const found = run('page.html', source).violations;
  assert.ok(found.length >= 2, 'fixture should produce findings to baseline');

  const cmp = compareToBaseline(found, buildBaseline(found, NOW));
  assert.equal(cmp.fresh.length, 0, 'nothing is new when the baseline was just built');
  assert.equal(cmp.matched, found.length);
  assert.equal(cmp.resolved, 0);
});

test('a finding absent from the baseline is reported', () => {
  const before = `<html lang="en"><head><title>T</title></head><body>
  <img src="a.png">
</body></html>`;
  const after = `<html lang="en"><head><title>T</title></head><body>
  <img src="a.png">
  <img src="new.png">
</body></html>`;

  const baseline = buildBaseline(run('page.html', before).violations, NOW);
  const cmp = compareToBaseline(run('page.html', after).violations, baseline);

  assert.equal(cmp.fresh.length, 1, 'the added image is the only new finding');
  assert.match(cmp.fresh[0].excerpt, /new\.png/);
});

test('editing lines above a finding does not make it look new', () => {
  // The whole point of fingerprinting on shape rather than position. If an unrelated edit
  // invalidated the baseline, people would regenerate it constantly and it would stop
  // meaning anything.
  const before = `<html lang="en"><head><title>T</title></head><body>
  <img src="a.png">
</body></html>`;
  const after = `<html lang="en"><head><title>T</title></head><body>
  <p>An unrelated paragraph.</p>
  <p>And another one.</p>
  <img src="a.png">
</body></html>`;

  const baseline = buildBaseline(run('page.html', before).violations, NOW);
  const cmp = compareToBaseline(run('page.html', after).violations, baseline);

  assert.equal(cmp.fresh.length, 0, 'the image finding moved but did not change');
});

test('reformatting a violation does not make it look new', () => {
  const before = `<html lang="en"><head><title>T</title></head><body><img src='a.png'></body></html>`;
  const after = `<html lang="en"><head><title>T</title></head><body>
  <img
      src="a.png"
  >
</body></html>`;

  const baseline = buildBaseline(run('page.html', before).violations, NOW);
  const cmp = compareToBaseline(run('page.html', after).violations, baseline);

  assert.equal(cmp.fresh.length, 0, 'quotes and whitespace are normalised out');
});

test('a third copy of a twice-baselined finding counts as new', () => {
  // A set-based comparison would miss this, and a regression would hide behind its own
  // ancestor.
  const v = (excerpt) => ({
    ruleId: 'A11Y-IMG-001',
    file: 'page.html',
    line: 1,
    column: 1,
    severity: 'error',
    message: 'x',
    excerpt,
  });
  const baseline = buildBaseline([v('<img src="a.png">'), v('<img src="a.png">')], NOW);
  const cmp = compareToBaseline(
    [v('<img src="a.png">'), v('<img src="a.png">'), v('<img src="a.png">')],
    baseline,
  );

  assert.equal(cmp.matched, 2);
  assert.equal(cmp.fresh.length, 1);
});

test('a fixed finding is reported as resolved, not as an error', () => {
  const before = `<html lang="en"><head><title>T</title></head><body>
  <img src="a.png">
  <img src="b.png">
</body></html>`;
  const after = `<html lang="en"><head><title>T</title></head><body>
  <img src="a.png" alt="Tabby cat asleep on a windowsill">
  <img src="b.png">
</body></html>`;

  const baseline = buildBaseline(run('page.html', before).violations, NOW);
  const cmp = compareToBaseline(run('page.html', after).violations, baseline);

  assert.equal(cmp.fresh.length, 0);
  assert.ok(cmp.resolved > 0, 'the baseline should report that it can be shrunk');
});

test('the same violation in a different file is a different fingerprint', () => {
  const v = (file) => ({
    ruleId: 'A11Y-IMG-001',
    file,
    line: 1,
    column: 1,
    severity: 'error',
    message: 'x',
    excerpt: '<img src="a.png">',
  });
  assert.notEqual(fingerprint(v('a.html')), fingerprint(v('b.html')));
});

test('a baseline round-trips through disk with sorted, diffable keys', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, '.a11yfix-baseline.json');
    const source = `<html lang="en"><head><title>T</title></head><body>
  <img src="z.png">
  <img src="a.png">
</body></html>`;
    const found = run('page.html', source).violations;
    const baseline = buildBaseline(found, NOW);
    await writeBaseline(path, baseline);

    const text = await readFile(path, 'utf8');
    assert.ok(text.endsWith('\n'), 'the file should end with a newline');
    const keys = Object.keys(JSON.parse(text).entries);
    assert.deepEqual(keys, [...keys].sort(), 'keys must be sorted so reviews are readable');

    const back = await readBaseline(path);
    assert.equal(back.version, 1);
    assert.equal(back.total, found.length);
    assert.equal(compareToBaseline(found, back).fresh.length, 0);
  });
});

test('a corrupt or foreign baseline fails with an actionable message', async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import('node:fs/promises');

    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{ not json', 'utf8');
    await assert.rejects(() => readBaseline(broken), /not valid JSON/);

    const foreign = join(dir, 'foreign.json');
    await writeFile(foreign, JSON.stringify({ version: 99, entries: {} }), 'utf8');
    await assert.rejects(() => readBaseline(foreign), /not an a11yfix baseline/);
  });
});
