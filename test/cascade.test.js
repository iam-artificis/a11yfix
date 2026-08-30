import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { parseMarkup } from '../dist/parse/markup.js';
import { Palette } from '../dist/design/palette.js';

/**
 * Resolving a value the way a browser would, or admitting it cannot.
 *
 * Both defects here produced confident, error-severity findings about text every browser
 * renders correctly — the failure mode the palette's own docstring says the design
 * prevents. Stylesheet rules were applied in parse order with no regard for specificity,
 * so `.hint { color:#ccc }` overrode `#alert { color:#111 }` and 18.9:1 text was reported
 * at 1.61:1. And a font-size in `em` was dropped, so the element inherited an ancestor's
 * pixels and a 24px callout was judged against the threshold for small text.
 */

const run = (file, source) =>
  analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: null });

const contrastOf = (source) =>
  run('page.html', source).violations.filter((v) => v.ruleId.startsWith('A11Y-COLOR'));

const page = (head, body) =>
  `<html lang="en"><head><title>t</title>${head}</head>` +
  `<body style="background-color:#ffffff"><main><h1>h</h1>${body}</main></body></html>`;

const typographyOf = (source) => {
  const markup = parseMarkup(source);
  const palette = new Palette(markup, 'page.html', []);
  const p = markup.elements.find((e) => e.tagLower === 'p');
  return palette.typographyFor(p);
};

test('an id selector beats a class selector written after it', () => {
  const source = page(
    '<style>#alert { color: #111111; } .hint { color: #cccccc; }</style>',
    '<p id="alert" class="hint">Your session will expire soon</p>',
  );
  assert.deepEqual(contrastOf(source), [], 'text rendered at 18.9:1 was reported as failing');
});

test('a class selector beats a tag selector written after it', () => {
  const source = page(
    '<style>.badge{color:#ffffff} span{color:#333333}</style>',
    '<p style="background-color:#333333"><span class="badge">NEW</span></p>',
  );
  assert.deepEqual(contrastOf(source), []);
});

test('between selectors of equal weight, the later one still wins', () => {
  const wins = page(
    '<style>.hint{color:#cccccc} .hint{color:#111111}</style>',
    '<p class="hint">Readable</p>',
  );
  assert.deepEqual(contrastOf(wins), [], 'the later rule sets a readable colour');

  const loses = page(
    '<style>.hint{color:#111111} .hint{color:#cccccc}</style>',
    '<p class="hint">Unreadable</p>',
  );
  assert.equal(contrastOf(loses).length, 1, 'the later rule sets an unreadable colour');
});

test('em and percent font sizes resolve against the parent chain', () => {
  const cases = [
    ['<div style="font-size:12px"><p style="font-size:2em;color:#111">x</p></div>', 24],
    ['<div style="font-size:40px"><p style="font-size:0.4em;color:#111">x</p></div>', 16],
    ['<div style="font-size:12px"><p style="font-size:150%;color:#111">x</p></div>', 18],
    [
      '<div style="font-size:12px"><section style="font-size:2em">' +
        '<p style="font-size:0.9em;color:#111">x</p></section></div>',
      21.6,
    ],
  ];
  for (const [body, expected] of cases) {
    const t = typographyOf(page('', body));
    assert.ok(t.certain, `${body}: size should be resolvable`);
    assert.ok(
      Math.abs(t.fontSizePx - expected) < 0.01,
      `${body}: resolved ${t.fontSizePx}px, expected ${expected}px`,
    );
  }
});

test('a relative size with nothing to multiply stays unknown rather than assumed', () => {
  // Guessing 16px here is what turns a checker into a confident liar. The threshold for
  // large text is different, so the guess decides whether a finding exists at all.
  const t = typographyOf(page('', '<div><p style="font-size:2em;color:#111">x</p></div>'));
  assert.equal(t.certain, false);
});

test('a size in a unit we cannot evaluate is not silently inherited', () => {
  const t = typographyOf(
    page('', '<div style="font-size:12px"><p style="font-size:clamp(1rem,2vw,3rem);color:#111">x</p></div>'),
  );
  assert.equal(t.certain, false, 'clamp() is not 12px just because the parent is');
});

test('text enlarged by em is judged against the large-text threshold', () => {
  // 24px at 3.03:1 passes AA for large text. Read as the parent's 12px it fails, and the
  // tool emitted an error and a patch for text that is fine.
  const source = page(
    '',
    '<div style="font-size:12px"><p style="font-size:2em;color:#949494">Callout</p></div>',
  );
  assert.deepEqual(contrastOf(source), []);
});

test('text shrunk by em is still checked at the small-text threshold', () => {
  // The mirror: real 16px text that fails, which the tool used to miss entirely because
  // it believed the parent's 40px.
  const source = page(
    '',
    '<div style="font-size:40px"><p style="font-size:0.4em;color:#949494">Small print</p></div>',
  );
  assert.equal(contrastOf(source).length, 1, 'a 16px failure was missed');
});
