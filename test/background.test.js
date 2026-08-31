import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';

/**
 * What the tool believes is behind the text.
 *
 * Every one of these came from scanning live sites rather than from a repository, and
 * that is the point: a Tailwind project writes `bg-slate-900`, which the tool has always
 * read. Hand-written CSS on a Bitrix site writes `background: var(--black)`, and the
 * first live scan of shm.ru turned twenty-nine white-on-black headings into twenty-nine
 * error-severity findings that white text was invisible on white — ninety per cent of
 * every contrast finding on the page.
 *
 * The failure mode all of these share is that an unread background silently becomes the
 * page default. A background the tool cannot read has to be *unknown*, because unknown
 * suppresses the finding and white invents one.
 */

const run = (source, sheets = []) =>
  analyseSource('page.html', source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: null,
    stylesheets: sheets.map((content, i) => ({ file: `s${i}.css`, content })),
  });

const contrast = (source, sheets) =>
  run(source, sheets).violations.filter((v) => v.ruleId === 'A11Y-COLOR-001');

const page = (body) =>
  `<!DOCTYPE html><html lang="ru"><head><title>т</title></head><body><main><h1>з</h1>${body}</main></body></html>`;

test('a custom property in a background shorthand is followed', () => {
  // shm.ru, reduced to its bones: the theme block that made the tool report white on
  // white twenty-nine times on one page.
  const css = `
    :root { --black: #000; --white: #FFF; }
    .black-block { background: var(--black); color: var(--white); }
  `;
  const found = contrast(page('<div class="black-block"><p style="font-size:16px">Текст</p></div>'), [css]);
  assert.deepEqual(
    found.map((v) => v.message),
    [],
    'white on black is 21:1 and must not be reported',
  );
});

test('a custom property with a fallback survives the split', () => {
  // `background: var(--black, #000)` contains a space. Splitting the value on whitespace
  // leaves "var(--black," and "#000)", and neither parses as anything.
  const css = `.b { background: var(--nope, #000000); color: #ffffff; }`;
  assert.deepEqual(contrast(page('<div class="b"><p style="font-size:16px">Т</p></div>'), [css]), []);
});

test('a functional colour with spaces in it survives the split', () => {
  const css = `.b { background: rgb(0, 0, 0); color: #ffffff; }`;
  assert.deepEqual(contrast(page('<div class="b"><p style="font-size:16px">Т</p></div>'), [css]), []);
});

test('a shorthand of nothing but position keywords leaves the element transparent', () => {
  // `background: no-repeat center` paints nothing, so the walk must carry on to the
  // parent rather than treat the element as an opaque unknown — otherwise a real finding
  // about the parent's colour disappears.
  const css = `
    .wrap { background: #ffffff; }
    .inner { background: no-repeat center / cover; }
    .inner p { color: #bbbbbb; font-size: 16px; }
  `;
  const found = contrast(page('<div class="wrap"><div class="inner"><p>Т</p></div></div>'), [css]);
  assert.equal(found.length, 1, 'the grey on white underneath is still a finding');
  assert.match(found[0].message, /#bbbbbb on #ffffff/);
});

test('a background the tool cannot read is unknown, not white', () => {
  // `inherit` is a real value with a real effect that this tool does not model. Reading
  // it as "no background" and falling through to the page default is how a dark section
  // becomes a page of findings about text that is perfectly legible.
  const css = `.b { background: inherit; color: #f2f2f2; }`;
  assert.deepEqual(
    contrast(page('<div class="b"><p style="font-size:16px">Т</p></div>'), [css]),
    [],
    'nothing can be said about contrast against a background we did not resolve',
  );
});

test('a gradient is still unknown, and a colour written after one still is', () => {
  const css = `.b { background: linear-gradient(#000, #333); color: #ffffff; }`;
  assert.deepEqual(contrast(page('<div class="b"><p style="font-size:16px">Т</p></div>'), [css]), []);
});

test('a shorthand colour overrides an image declared before it', () => {
  // The shorthand resets background-image. If the earlier url() kept the element marked
  // unknown, the grey-on-white finding underneath would never be made.
  const css = `.b { background-image: url(hero.jpg); background: #ffffff; }
               .b p { color: #b0b0b0; font-size: 16px; }`;
  const found = contrast(page('<div class="b"><p>Т</p></div>'), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#b0b0b0 on #ffffff/);
});

test('text the exact colour of its background is not reported', () => {
  // 1.00:1 is not a design. It is what the tool computes when it did not see the real
  // backdrop — a hero image on a sibling, a class a script adds, a selector this cascade
  // does not implement. Seven live sites produced fifteen of these and not one was real.
  const css = `.hero { background: #ffffff; } .hero p { color: #ffffff; font-size: 16px; }`;
  assert.deepEqual(contrast(page('<div class="hero"><p>Т</p></div>'), [css]), []);
});

test('the suppression is narrow: near-identical is still reported', () => {
  // The guard is "exactly the same colour", not "close". Off-white on white is a real
  // and common mistake, and it stays a finding.
  const css = `.hero { background: #ffffff; } .hero p { color: #fdfdfd; font-size: 16px; }`;
  const found = contrast(page('<div class="hero"><p>Т</p></div>'), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#fdfdfd on #ffffff/);
});

test('the ordinary finding this tool exists for is untouched by all of it', () => {
  const css = `body { background: #ffffff; } p { color: #999999; font-size: 16px; }`;
  const found = contrast(page('<p>Т</p>'), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#999999 on #ffffff/);
  assert.equal(found[0].severity, 'error');
});

/**
 * Selector reach.
 *
 * Until this worked, a stylesheet written the way people actually write them was mostly
 * invisible to the tool: `.footer p { color: #999 }` styles nothing it could see. That is
 * not only missed findings. A rule that *overrides* the one we did apply, ignored, turns
 * legible text into a finding — so reading more of the cascade is a precision fix too.
 */

test('a descendant selector reaches the element it styles', () => {
  const css = `body { background: #ffffff; } .footer p { color: #999999; font-size: 16px; }`;
  const found = contrast(page('<div class="footer"><p>Т</p></div>'), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#999999 on #ffffff/);
});

test('a child combinator does not reach a grandchild', () => {
  const css = `body { background: #ffffff; } .footer > p { color: #999999; font-size: 16px; }`;
  assert.deepEqual(
    contrast(page('<div class="footer"><div><p>Т</p></div></div>'), [css]),
    [],
    '`>` means the parent, and a wrong match here would invent a colour',
  );
});

test('a more specific rule overrides a less specific one, wherever it sits', () => {
  // The case that made this a precision fix rather than a coverage one: without
  // descendant support the tool saw only `.text` and reported a violation on text the
  // page draws at 12:1.
  const css = `
    body { background: #ffffff; }
    .text { color: #cccccc; font-size: 16px; }
    .card .text { color: #333333; }
  `;
  assert.deepEqual(contrast(page('<div class="card"><p class="text">Т</p></div>'), [css]), []);
  // Outside the card the weaker rule is still the one that applies.
  assert.equal(contrast(page('<p class="text">Т</p>'), [css]).length, 1);
});

test('a compound selector needs every class present', () => {
  const css = `body { background: #ffffff; } .a.b { color: #999999; font-size: 16px; }`;
  assert.equal(contrast(page('<p class="a b">Т</p>'), [css]).length, 1);
  assert.deepEqual(contrast(page('<p class="a">Т</p>'), [css]), []);
});

test('a selector whose answer depends on state is still refused', () => {
  // :hover describes a moment, not a page. Applying it would mix colour pairs that never
  // co-occur, which is the failure this module was built to avoid.
  const css = `body { background: #ffffff; } p:hover { color: #999999; font-size: 16px; }`;
  assert.deepEqual(contrast(page('<p>Т</p>'), [css]), []);
});
