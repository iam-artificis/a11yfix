import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { TODO_MARKER } from '../dist/types.js';

/**
 * A fix must never turn a red build green without a person doing anything.
 *
 * A11Y-DOC-001's review fix wrote `lang=""` and a marker attribute. After that DOC-001
 * stopped firing — an attribute existed — DOC-002 explicitly skipped empty values, and
 * nothing in the codebase ever read the marker. So `--fix --include-review` deleted the
 * error: a page declaring no language reported "No violations found" and exited 0.
 *
 * That is the failure this whole tool argues against, arriving from inside the tool. The
 * property below is the general form of it, checked over every fixable finding rather
 * than over the one case that happened to be found.
 */

const analyse = (file, source, threshold) =>
  analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: threshold });

/** Every error-severity rule that fires on a source, as a set of rule ids. */
const errorsOn = (file, source) =>
  new Set(
    analyse(file, source, null)
      .violations.filter((v) => v.severity === 'error')
      .map((v) => v.ruleId),
  );

const BROKEN_PAGES = {
  'no lang': `<!doctype html>
<html><head><title>Orders</title></head><body><main><h1>Orders</h1></main></body></html>
`,
  'no title': `<!doctype html>
<html lang="en"><head></head><body><main><h1>Orders</h1></main></body></html>
`,
  'unnamed controls': `<!doctype html>
<html lang="en"><head><title>Signup</title></head><body><main><h1>Signup</h1>
<form><input type="text" name="fullName"><button></button></form>
</main></body></html>
`,
  'unnamed image and link': `<!doctype html>
<html lang="en"><head><title>Gallery</title></head><body><main><h1>Gallery</h1>
<img src="hero.png">
<a href="/x"><span></span></a>
</main></body></html>
`,
};

for (const [name, source] of Object.entries(BROKEN_PAGES)) {
  test(`applying every fix does not empty the build: ${name}`, () => {
    const before = errorsOn('page.html', source);
    assert.ok(before.size > 0, 'fixture should start with errors');

    for (const threshold of ['automatic', 'review']) {
      const fixed = analyse('page.html', source, threshold).fixedSource ?? source;
      const after = errorsOn('page.html', fixed);
      assert.ok(
        after.size > 0,
        `--fix${threshold === 'review' ? ' --include-review' : ''} left no errors on a page ` +
          `that still has the defect (was: ${[...before].join(', ')})`,
      );
    }
  });
}

test('a placeholder left in the source is itself an error', () => {
  // The general mechanism, independent of which rule wrote the placeholder. Without it,
  // a half-finished fix is indistinguishable from a finished one to every checker
  // downstream, including this one.
  const source = `<!doctype html>
<html lang="en"><head><title>Gallery</title></head><body><main><h1>Gallery</h1>
<img src="hero.png" alt="${TODO_MARKER}: describe this image">
</main></body></html>
`;
  const violations = analyse('page.html', source, null).violations;
  const todo = violations.filter((v) => v.ruleId === 'A11Y-TODO-001');
  assert.equal(todo.length, 1, `expected one placeholder finding, got ${todo.length}`);
  assert.equal(todo[0].severity, 'error', 'a half-finished fix has to fail the build');
  assert.ok(todo[0].fix?.edits.length === 0, 'the tool must not write the missing words itself');
});

test('the placeholder rule is quiet on a file that has none', () => {
  const source = `<!doctype html>
<html lang="en"><head><title>Gallery</title></head><body><main><h1>Gallery</h1>
<img src="hero.png" alt="A cat asleep on a windowsill">
</main></body></html>
`;
  const ids = analyse('page.html', source, null).violations.map((v) => v.ruleId);
  assert.ok(!ids.includes('A11Y-TODO-001'), `false placeholder finding: ${ids.join(', ')}`);
});

test('every placeholder in a file is reported, not just the first', () => {
  const source = `<!doctype html>
<html lang="en"><head><title>${TODO_MARKER}: name this page</title></head>
<body><main><h1>Gallery</h1>
<img src="a.png" alt="${TODO_MARKER}: describe this image">
<img src="b.png" alt="${TODO_MARKER}: describe this image">
</main></body></html>
`;
  const todo = analyse('page.html', source, null).violations.filter(
    (v) => v.ruleId === 'A11Y-TODO-001',
  );
  assert.equal(todo.length, 3);
  // Each has to point somewhere different, or two of them are useless.
  assert.equal(new Set(todo.map((v) => `${v.line}:${v.column}`)).size, 3);
});

test('lang="" is reported rather than accepted as a language', () => {
  const source = `<!doctype html>
<html lang=""><head><title>Orders</title></head><body><main><h1>Orders</h1></main></body></html>
`;
  const v = analyse('page.html', source, null).violations.find(
    (x) => x.ruleId === 'A11Y-DOC-002',
  );
  assert.ok(v !== undefined, 'lang="" must be reported: it names no language');
  assert.equal(v.severity, 'error');
  // And the tool must not guess which language was meant.
  assert.equal(v.fix?.edits.length ?? 0, 0);
});

test('a marker can actually reach a file, and fails the next run', () => {
  // The README and comparison.md both sell this: nothing is written into a name
  // position except an empty value "or a marker that fails CI". Every marker-writing
  // fix was safety 'manual', and 'manual' is above the highest threshold the CLI can
  // ask for — so no invocation could produce a marker, and A11Y-TODO-001, written to
  // catch them, had nothing to catch. The claim was unfalsifiable rather than true.
  const source = `export const A = () => (<div><a href="/x"><span /></a></div>);`;

  const without = analyseSource('A.tsx', source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: 'review',
  });
  assert.ok(
    !(without.fixedSource ?? '').includes(TODO_MARKER),
    'a marker must not be written by --include-review',
  );

  const with_ = analyseSource('A.tsx', source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: 'review',
    markTodos: true,
  });
  assert.ok(with_.fixedSource !== undefined, '--mark-todos wrote nothing');
  assert.ok(with_.fixedSource.includes(TODO_MARKER), `no marker in: ${with_.fixedSource}`);

  const after = analyse('A.tsx', with_.fixedSource, null).violations;
  const todo = after.filter((v) => v.ruleId === 'A11Y-TODO-001');
  assert.equal(todo.length, 1, 'the marker left in the file was not reported');
  assert.equal(todo[0].severity, 'error', 'a marker must fail the build, not warn');
});
