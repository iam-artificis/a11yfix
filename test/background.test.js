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

test('a pair no reader could tell apart is not reported either', () => {
  // This test used to assert the opposite, on the reasoning that the guard should be
  // "exactly the same colour" and never "close", because off-white on white is a real
  // and common mistake. A wider corpus disagreed with the premise at these ratios.
  //
  // Reading `!important` into the cascade un-skipped a class of element the parser used
  // to drop, and nine of the findings that appeared were white text on #fbfbfb — nlr.ru's
  // `body { background-color: #FBFBFB !important }` under a header whose real backdrop we
  // still cannot see. rsl.ru produced forty-five more at 1.09:1. Not one of the
  // fifty-four was real. At 1.03:1 nobody is shipping a design; it is what this tool
  // computes when it did not see the backdrop, exactly as at 1.00:1.
  const css = `.hero { background: #ffffff; } .hero p { color: #fdfdfd; font-size: 16px; }`;
  assert.deepEqual(contrast(page('<div class="hero"><p>Т</p></div>'), [css]), []);
});

test('the suppression is narrow: faint but readable is still reported', () => {
  // The line has moved, not disappeared. #e0e0e0 on white is 1.32:1 — still invisible to
  // most people, still a finding, and still nowhere near the 2.5:1 where the complaint
  // this tool exists to make actually lives.
  const css = `.hero { background: #ffffff; } .hero p { color: #e0e0e0; font-size: 16px; }`;
  const found = contrast(page('<div class="hero"><p>Т</p></div>'), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#e0e0e0 on #ffffff/);
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

/**
 * The cascade's other half.
 *
 * `!important` was parsed as part of the value and then never looked at, which is two
 * defects wearing one coat. A losing important declaration lost, so the museum this tool
 * is aimed at was told its white event captions sat on light grey — 102 findings, each
 * advising it to turn legible white text mid-grey. And a winning one produced
 * `parseColor('#fff !important')`, which is null, so the element was skipped entirely.
 */

test('an important declaration beats a more specific one that is not important', () => {
  // shm.ru in miniature. `.card` is the weaker selector and wins anyway.
  const css = `.card { background: #ffffff !important; }
               .wrap .card { background: #f0f0f0; }
               .card p { color: #ffffff; font-size: 16px; }`;
  // White on white after the important declaration is honoured, and therefore silent —
  // the same-colour guard declines to guess at a backdrop it evidently cannot see.
  assert.deepEqual(contrast(page('<div class="wrap"><div class="card"><p>Т</p></div></div>'), [css]), []);
});

// #999999 under white is 2.85:1 and fails; #000000 is 21:1 and passes. Every test below
// distinguishes the two candidate backgrounds by which of those two answers comes out,
// so a wrong winner cannot pass by accident. (An earlier draft used #767676, which is
// 4.54:1 — it passes AA, so all three tests were silently asserting nothing.)

test('an important declaration loses to an important one that is more specific', () => {
  const css = `.card { background: #000000 !important; }
               .wrap .card { background: #999999 !important; }
               .card p { color: #ffffff; font-size: 16px; }`;
  const found = contrast(page('<div class="wrap"><div class="card"><p>Т</p></div></div>'), [css]);
  assert.equal(found.length, 1, 'the more specific important declaration should win');
  assert.match(found[0].message, /#ffffff on #999999/);
});

test('an important declaration in a stylesheet beats an inline style', () => {
  // The arrangement every CMS theme uses to hold its own against component markup.
  const css = `.card { background: #999999 !important; } .card p { color: #ffffff; font-size: 16px; }`;
  const found = contrast(page('<div class="card" style="background:#000000"><p>Т</p></div>'), [css]);
  assert.equal(found.length, 1, 'the stylesheet !important should outrank the inline style');
  assert.match(found[0].message, /#ffffff on #999999/);
});

test('an inline important beats a stylesheet important', () => {
  const css = `.card { background: #000000 !important; } .card p { color: #ffffff; font-size: 16px; }`;
  const found = contrast(page('<div class="card" style="background:#999999 !important"><p>Т</p></div>'), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#ffffff on #999999/);
});

test('a colour marked important is still read, not skipped', () => {
  // The second arm: the value used to reach parseColor with the flag still attached.
  const css = `.card { background: #ffffff !important; } .card p { color: #999999 !important; font-size: 16px; }`;
  const found = contrast(page('<div class="card"><p>Т</p></div>'), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#999999 on #ffffff/);
});

test('a repair rewrites the colour and leaves the important flag alone', () => {
  // The recorded span stops before `!important`, so applying a fix cannot silently
  // change which rule wins on the client's page.
  const css = `.card { background: #ffffff; } .card p { color: #999999 !important; font-size: 16px; }`;
  const found = run(page('<div class="card"><p>Т</p></div>'), [css]).violations.filter(
    (v) => v.ruleId === 'A11Y-COLOR-001',
  );
  assert.equal(found.length, 1);
  for (const edit of found[0].fix?.edits ?? []) {
    assert.ok(
      !/!\s*important/i.test(css.slice(edit.start, edit.end)),
      'the edit range must not cover the !important flag',
    );
  }
});

test('font-weight: bold !important is still bold', () => {
  // 20px bold is large text and held to 3:1; read as not-bold it was held to 4.5:1 and
  // reported at 3.45:1.
  const css = `.card { background: #ffffff; }
               .card p { color: #767676; font-size: 20px; font-weight: bold !important; }`;
  assert.deepEqual(contrast(page('<div class="card"><p>Т</p></div>'), [css]), []);
});

/**
 * Positioning, read from the stylesheet rather than from Tailwind class names.
 *
 * The overlay tests used to look at the class attribute and the `style` attribute and
 * nowhere else, which is a test for one framework. Every site in the Russian corpus
 * positions in a .css file.
 */

test('text under a stretched overlay declared in a stylesheet is not measured', () => {
  const css = `.card { position: relative; height: 200px; background: #ffffff; }
               .card .scrim { position: absolute; inset: 0; background: #000000; }
               .card p { color: #ffffff; font-size: 16px; }`;
  assert.deepEqual(
    contrast(page('<div class="card"><div class="scrim"></div><p>Т</p></div>'), [css]),
    [],
    'the scrim is declared in CSS, not in a class name',
  );
});

test('text in an absolutely positioned box over a sibling image is not measured', () => {
  // spbu.ru's slider: the caption floats over a photograph in the preceding sibling, and
  // the white four levels up is real but is not what is behind this text.
  const css = `.slide { position: relative; background: #ffffff; }
               .slide .content { position: absolute; bottom: 0; left: 0; }
               .slide .content span { color: #ffffff; font-size: 16px; }`;
  const body =
    '<div class="slide"><div class="media"><img src="/hero.jpg" alt="Фото"></div>' +
    '<div class="content"><span>Подробнее</span></div></div>';
  assert.deepEqual(contrast(page(body), [css]), []);
});

test('an absolutely positioned box that paints itself is still measured', () => {
  // The narrowing that keeps the rule above useful: a dropdown with its own opaque
  // background knows exactly what is behind its text.
  const css = `.slide { position: relative; background: #ffffff; }
               .slide .menu { position: absolute; bottom: 0; background: #ffffff; }
               .slide .menu a { color: #999999; font-size: 16px; }`;
  const body =
    '<div class="slide"><div class="media"><img src="/hero.jpg" alt="Фото"></div>' +
    '<div class="menu"><a href="/x">Пункт</a></div></div>';
  const found = contrast(page(body), [css]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /#999999 on #ffffff/);
});

test('a translucent layer flattened onto the assumed page default is not measured', () => {
  // Exact arithmetic on an invented input. Every layer is real; the thing at the bottom
  // is a guess, and a layer is translucent precisely because something is meant to show
  // through it.
  const css = `.scrim { background: rgba(0, 0, 0, 0.2); } .scrim p { color: #ffffff; font-size: 16px; }`;
  assert.deepEqual(contrast(page('<div class="scrim"><p>Т</p></div>'), [css]), []);
});

test('a translucent layer over a declared colour is measured as normal', () => {
  const css = `.box { background: #ffffff; }
               .box .scrim { background: rgba(0, 0, 0, 0.2); }
               .box .scrim p { color: #ffffff; font-size: 16px; }`;
  const found = contrast(page('<div class="box"><div class="scrim"><p>Т</p></div></div>'), [css]);
  assert.equal(found.length, 1, 'the base is declared, so the composite is a measurement');
});
