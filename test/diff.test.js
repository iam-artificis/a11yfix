import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarkup } from '../dist/parse/markup.js';
import { applyEdits, unifiedDiff, diffLines } from '../dist/fix/apply.js';

/**
 * The acceptance test for the whole product.
 *
 * A11yFix's entire promise is "here is a patch". If a patch we emit does not apply, or
 * applies to something other than what we said it would produce, the tool is worse than
 * useless: it has spent the user's trust on a broken artefact. So the diff is not checked
 * against a golden string — it is round-tripped through real `git apply` and compared
 * byte-for-byte with the direct edit, across every line-ending and final-newline
 * combination that shows up in practice.
 */

let repo;
let gitAvailable = true;

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });

before(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
  } catch {
    gitAvailable = false;
    return;
  }
  repo = mkdtempSync(join(tmpdir(), 'a11yfix-diff-'));
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  // Git must not touch line endings, or the round-trip would be testing git's
  // normalisation rather than our diff.
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.safecrlf', 'false');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'a11yfix test');
});

after(() => {
  if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
});

/** A small, realistic edit set: one attribute value replaced, one attribute inserted. */
function editSource(source) {
  const markup = parseMarkup(source);
  const edits = [];
  for (const el of markup.elements) {
    if (el.tagLower === 'p') {
      const style = el.attrs.find((a) => a.nameLower === 'style');
      if (style !== undefined) {
        edits.push({
          start: style.valueStart,
          end: style.valueEnd,
          replacement: '"color:#767676"',
          label: 'contrast',
        });
      }
    }
    if (el.tagLower === 'img' && !el.attrs.some((a) => a.nameLower === 'alt')) {
      edits.push({ start: el.openEnd - 1, end: el.openEnd - 1, replacement: ' alt=""', label: 'alt' });
    }
  }
  return applyEdits(source, edits).output;
}

function roundTrip(name, source) {
  const expected = editSource(source);
  assert.notEqual(expected, source, `${name}: fixture produced no edit, so it tests nothing`);

  const diff = unifiedDiff('t.html', source, expected);
  const worktree = join(repo, 'case');
  rmSync(worktree, { recursive: true, force: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 't.html'), source);
  git('add', '-A');
  git('commit', '-qm', 'fixture', '--allow-empty');
  writeFileSync(join(repo, 'patch.diff'), diff);

  try {
    git('apply', '--directory=case', 'patch.diff');
  } catch (err) {
    const detail = String(err.stderr ?? err.message).trim();
    assert.fail(`${name}: git apply rejected the patch\n${detail}\n--- diff ---\n${diff}`);
  }

  const actual = readFileSync(join(worktree, 't.html'), 'utf8');
  assert.equal(actual, expected, `${name}: patch applied but produced different bytes`);
}

/**
 * Round-trip an arbitrary pair of texts, not just a realistic edit.
 *
 * The hand-written cases below cover the shapes somebody thought of. This covers the
 * ones nobody did. The defect it exists for: the "\\ No newline at end of file" marker
 * was emitted after any op at the last index of its side, including a context line with
 * insertions after it — which tells git the file ends there on *both* sides. git then
 * either rejected the patch or, worse, accepted it and concatenated the following lines
 * onto the context line. Neither side ending in a newline was enough to trigger it;
 * 24% of random single edits of that shape came out wrong.
 */
function roundTripPair(name, before, after) {
  const diff = unifiedDiff('t.html', before, after);
  if (diff === '') {
    assert.equal(before, after, `${name}: empty diff for two different texts`);
    return;
  }

  // No staging and no commit: `git apply` reads the working tree, and committing every
  // case turned a two-second fuzz into eighty.
  const worktree = join(repo, 'case');
  rmSync(worktree, { recursive: true, force: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 't.html'), before);
  writeFileSync(join(repo, 'patch.diff'), diff);

  try {
    git('apply', '--directory=case', 'patch.diff');
  } catch (err) {
    const detail = String(err.stderr ?? err.message).trim();
    assert.fail(`${name}: git apply rejected the patch\n${detail}\n--- diff ---\n${diff}`);
  }

  const actual = readFileSync(join(worktree, 't.html'), 'utf8');
  assert.equal(actual, after, `${name}: patch applied but produced different bytes`);
}

test('random edits round-trip through git apply, with and without final newlines', () => {
  // A fixed seed: every run exercises the same 240 cases, so a failure is reproducible
  // from the case number alone rather than being a story about a flaky test.
  let seed = 20260831;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

  const words = ['a', 'b', 'c', 'alpha', 'beta', '<p>x</p>', '  indented', ''];

  for (let n = 0; n < 240; n++) {
    const lineCount = 1 + Math.floor(rnd() * 6);
    const lines = Array.from({ length: lineCount }, () => pick(words));

    // Mutate: replace, insert or delete one line.
    const edited = [...lines];
    const at = Math.floor(rnd() * edited.length);
    const kind = Math.floor(rnd() * 3);
    if (kind === 0) edited[at] = pick(words) + 'MOD';
    else if (kind === 1) edited.splice(at, 0, pick(words) + 'NEW');
    else edited.splice(at, 1);
    if (edited.length === 0) edited.push('only');

    // The interesting axis: whether each side ends in a newline. All four combinations.
    for (const [endBefore, endAfter] of [[false, false], [false, true], [true, false], [true, true]]) {
      const before = lines.join('\n') + (endBefore ? '\n' : '');
      const after = edited.join('\n') + (endAfter ? '\n' : '');
      if (before === after) continue;
      roundTripPair(`case ${n} (${endBefore ? 'LF' : 'no-LF'} -> ${endAfter ? 'LF' : 'no-LF'})`, before, after);
    }
  }
});

test('a surviving last line with insertions after it is not marked as final', () => {
  // The exact shape the marker used to get wrong, kept as a named case so a regression
  // reads as one rather than as "fuzz case 137 failed".
  const diff = unifiedDiff('f.txt', 'c', 'c\nbMOD');
  const lines = diff.split('\n');
  const marker = '\\ No newline at end of file';
  const contextC = lines.indexOf(' c');
  assert.equal(contextC, -1, 'a line whose newline state differs must be rewritten, not kept as context');
  assert.equal(lines.filter((l) => l === marker).length, 2, 'both sides end without a newline');
  roundTripPair('surviving last line', 'c', 'c\nbMOD');
});

test('removing trailing lines produces a patch git accepts', () => {
  roundTripPair('trailing lines removed', 'a\nb\n', 'a');
  roundTripPair('trailing lines removed, no final newline either side', 'a\nb', 'a');
});

const BODY = '<html>\n<body>\n  <img src="a.png">\n  <p style="color:#999">Hi</p>\n  <span>tail</span>\n</body>\n</html>';
const crlf = (s) => s.replace(/\n/g, '\r\n');

const CASES = [
  ['LF without a final newline', BODY],
  ['LF with a final newline', BODY + '\n'],
  ['CRLF without a final newline', crlf(BODY)],
  ['CRLF with a final newline', crlf(BODY) + '\r\n'],
  ['a single line with no newline at all', '<p style="color:#999">x</p><img src="a.png">'],
  ['a change on the last line', '<html>\n<div>ok</div>\n<p style="color:#999">last</p>'],
  [
    'a file long enough to need real hunk context',
    Array.from({ length: 400 }, (_, i) => `<div>line ${i}</div>`).join('\n') +
      '\n<p style="color:#999">Hi</p>\n<img src="a.png">\n' +
      Array.from({ length: 400 }, (_, i) => `<div>tail ${i}</div>`).join('\n'),
  ],
  [
    'two changes far enough apart to need two hunks',
    '<p style="color:#999">head</p>\n' +
      Array.from({ length: 60 }, (_, i) => `<div>${i}</div>`).join('\n') +
      '\n<img src="z.png">\n',
  ],
];

for (const [name, source] of CASES) {
  test(`the patch applies and is byte-exact: ${name}`, (t) => {
    if (!gitAvailable) return t.skip('git is not installed');
    roundTrip(name, source);
  });
}

test('an unchanged file produces an empty diff, not an empty hunk', () => {
  const source = '<p>nothing to do</p>\n';
  assert.equal(unifiedDiff('t.html', source, source), '');
});

test('the no-newline marker appears on exactly the sides that lack one', () => {
  const withNewline = unifiedDiff('t.html', '<p>a</p>\n', '<p>b</p>\n');
  assert.ok(!withNewline.includes('\\ No newline'), 'marker emitted for a file that ends in a newline');

  const withoutBoth = unifiedDiff('t.html', '<p>a</p>', '<p>b</p>');
  assert.equal(
    (withoutBoth.match(/\\ No newline at end of file/g) ?? []).length,
    2,
    'both sides lack a trailing newline, so both need the marker',
  );

  const gained = unifiedDiff('t.html', '<p>a</p>', '<p>a</p>\n');
  assert.equal(
    (gained.match(/\\ No newline at end of file/g) ?? []).length,
    1,
    'only the original side lacks a trailing newline',
  );
});

test('diffLines reports a minimal edit script', () => {
  // Inserting one line in the middle must not be reported as "deleted everything,
  // added everything" — that would make every patch unreviewable.
  const a = ['a', 'b', 'c', 'd'];
  const b = ['a', 'b', 'x', 'c', 'd'];
  const ops = diffLines(a, b);
  assert.equal(ops.filter((o) => o.kind === '+').length, 1);
  assert.equal(ops.filter((o) => o.kind === '-').length, 0);
  assert.equal(ops.filter((o) => o.kind === ' ').length, 4);
});

test('applyEdits refuses to apply overlapping edits rather than corrupting the file', () => {
  const source = '<p style="color:#999">x</p>';
  const result = applyEdits(source, [
    { start: 3, end: 20, replacement: 'A', label: 'first' },
    { start: 10, end: 25, replacement: 'B', label: 'second' },
  ]);
  assert.equal(result.conflicted.length, 1, 'the second, overlapping edit must be refused');
  assert.ok(result.output.includes('A'));
  assert.ok(!result.output.includes('B'));
});

test('applyEdits is order-independent', () => {
  const source = '<a href="/x">one</a><a href="/y">two</a>';
  const edits = [
    { start: 12, end: 12, replacement: ' rel="noopener"', label: 'a' },
    { start: 32, end: 32, replacement: ' rel="noopener"', label: 'b' },
  ];
  const forward = applyEdits(source, edits).output;
  const reversed = applyEdits(source, [...edits].reverse()).output;
  assert.equal(forward, reversed);
});
