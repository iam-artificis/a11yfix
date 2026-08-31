import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkup, getAttr, hasAttr, textOf, positionAt } from '../dist/parse/markup.js';
import { parseSelector } from '../dist/design/selector.js';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import {
  parseCss,
  parseInlineStyle,
  lengthToPx,
  isBoldWeight,
} from '../dist/parse/css.js';
import {
  resolveTailwindColor,
  resolveTailwindClasses,
  nearestShade,
  familyOf,
} from '../dist/design/tailwind.js';

/**
 * Everything downstream depends on one property: the offsets the tokeniser reports are
 * the real offsets in the file. A rule that finds a genuine violation but points a few
 * characters off writes a patch into the middle of an attribute name. These tests check
 * offsets against the source text itself rather than against expected numbers, so they
 * keep their meaning when the fixtures change.
 */

const parse = (s) => parseMarkup(s);
const attr = (el, name) => getAttr(el, name)?.value;

test('every reported offset indexes the text it claims to', () => {
  const source = `<!DOCTYPE html>
<html lang="en">
  <body class='greeting' data-x=bare>
    <img src="a.png" alt="A cat" />
    <input disabled type="text">
    <a href={url} title={t('x')}>link</a>
  </body>
</html>`;
  const { elements } = parse(source);
  assert.ok(elements.length >= 5, `expected at least 5 elements, got ${elements.length}`);

  for (const el of elements) {
    assert.equal(
      source.slice(el.openStart, el.openStart + 1 + el.tag.length),
      '<' + el.tag,
      `open tag offset wrong for <${el.tag}>`,
    );
    assert.equal(source[el.openEnd - 1], '>', `openEnd does not point past '>' for <${el.tag}>`);
    for (const a of el.attrs) {
      assert.equal(
        source.slice(a.nameStart, a.nameEnd),
        a.name,
        `attribute name offset wrong for ${a.name}`,
      );
      // A valueless attribute (disabled, checked) has no value range to check.
      if (a.value === null || a.value === undefined || a.value === '') continue;
      const raw = source.slice(a.valueStart, a.valueEnd);
      assert.ok(
        raw.includes(a.value),
        `value offset wrong for ${a.name}: raw ${JSON.stringify(raw)} vs ${JSON.stringify(a.value)}`,
      );
    }
  }
});

test('all three quoting styles and unquoted values are read', () => {
  const { elements } = parse(`<div a="one" b='two' c=three d>x</div>`);
  const div = elements[0];
  assert.equal(attr(div, 'a'), 'one');
  assert.equal(attr(div, 'b'), 'two');
  assert.equal(attr(div, 'c'), 'three');
  assert.ok(hasAttr(div, 'd'), 'a valueless attribute must still be present');
});

test('attribute names are matched case-insensitively but preserved as written', () => {
  const { elements } = parse(`<IMG SRC="a.png" ALT="Cat">`);
  const img = elements[0];
  assert.equal(img.tagLower, 'img');
  assert.equal(img.tag, 'IMG');
  assert.equal(attr(img, 'alt'), 'Cat');
  assert.equal(img.attrs[0].name, 'SRC');
});

test('a JSX expression is captured whole, including nested braces and strings', () => {
  const source = `<div style={{ color: '#777', pad: fn({ a: 1 }) }} onClick={() => go('}')}>x</div>`;
  const { elements } = parse(source);
  const div = elements[0];
  const style = getAttr(div, 'style');
  assert.ok(style.dynamic, 'a brace value must be marked dynamic');
  const raw = source.slice(style.valueStart, style.valueEnd);
  const opens = (raw.match(/\{/g) ?? []).length;
  const closes = (raw.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, `unbalanced capture: ${raw}`);
  assert.ok(raw.includes("'#777'"), 'the whole expression must be captured');

  const click = getAttr(div, 'onclick');
  assert.ok(click.dynamic);
  assert.ok(
    source.slice(click.valueStart, click.valueEnd).includes("'}'"),
    'a closing brace inside a string must not end the expression',
  );
});

test('void elements do not swallow their siblings', () => {
  const { elements } = parse(`<div><img src="a.png"><br><p>after</p></div>`);
  const div = elements.find((e) => e.tagLower === 'div');
  const p = elements.find((e) => e.tagLower === 'p');
  assert.equal(p.depth, div.depth + 1, '<p> must be a child of <div>, not of <img>');
});

test('script and style contents are not parsed as markup', () => {
  const source = `<html><body><script>if (a < b) { document.write("<img src=x>") }</script><p>real</p></body></html>`;
  const { elements } = parse(source);
  assert.equal(
    elements.filter((e) => e.tagLower === 'img').length,
    0,
    'markup inside a script must not be reported as an element',
  );
  assert.ok(elements.some((e) => e.tagLower === 'p'));
});

test('textOf ignores script and style text', () => {
  const source = `<button><style>.a{content:"click"}</style><script>var x="press"</script>Send</button>`;
  const { elements } = parse(source);
  const button = elements.find((e) => e.tagLower === 'button');
  assert.equal(textOf(button).trim(), 'Send');
});

test('comments and doctypes are skipped without shifting offsets', () => {
  const source = `<!DOCTYPE html>\n<!-- <img src="ghost.png"> -->\n<p id="real">x</p>`;
  const { elements } = parse(source);
  assert.equal(elements.filter((e) => e.tagLower === 'img').length, 0);
  const p = elements.find((e) => e.tagLower === 'p');
  assert.equal(source.slice(p.openStart, p.openStart + 2), '<p');
});

test('positionAt agrees with counting newlines by hand', () => {
  const source = 'one\ntwo\nthree\nfour';
  assert.deepEqual(positionAt(source, 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt(source, 4), { line: 2, column: 1 });
  assert.deepEqual(positionAt(source, 6), { line: 2, column: 3 });
  assert.deepEqual(positionAt(source, source.length), { line: 4, column: 5 });
});

test('unterminated markup does not hang or throw', () => {
  for (const bad of [
    '<div class="unclosed',
    '<a href=',
    '<<<>>>',
    '<!-- never closed',
    '<div {...rest}',
    '<div style={{',
  ]) {
    const result = parse(bad);
    assert.ok(Array.isArray(result.elements), `parser failed on ${JSON.stringify(bad)}`);
  }
});

test('CSS comments are blanked without moving any offset', () => {
  const source = `.a { color: red } /* .b { color: blue } */ .c { color: green }`;
  const { rules } = parseCss(source);
  const selectors = rules.map((r) => r.selector);
  assert.ok(selectors.includes('.a'));
  assert.ok(selectors.includes('.c'));
  assert.ok(!selectors.includes('.b'), 'a commented-out rule must not be read');

  for (const rule of rules) {
    for (const decl of rule.declarations) {
      assert.equal(
        source.slice(decl.valueStart, decl.valueEnd).trim(),
        decl.value,
        `declaration offset wrong for ${decl.prop}`,
      );
      assert.equal(source.slice(decl.propStart, decl.propStart + decl.prop.length), decl.prop);
    }
  }
});

test('rules inside a media query are marked conditional', () => {
  const { rules } = parseCss(
    `.a { color: #111 } @media (min-width: 40rem) { .a { color: #eee } }`,
  );
  const plain = rules.filter((r) => r.conditions.length === 0);
  const conditional = rules.filter((r) => r.conditions.length > 0);
  assert.equal(plain.length, 1);
  assert.equal(conditional.length, 1);
  assert.match(conditional[0].conditions[0], /min-width/);
});

test('a Tailwind v4 @theme block is read as custom properties', () => {
  const { rootVariables } = parseCss(
    `@theme { --color-brand: #4f46e5; --color-muted: oklch(0.7 0 0); }`,
  );
  assert.equal(rootVariables['--color-brand'], '#4f46e5');
  assert.ok('--color-muted' in rootVariables);
});

test(':root custom properties are collected', () => {
  const { rootVariables } = parseCss(`:root { --fg: #222; --bg: #fff } .a { color: var(--fg) }`);
  assert.equal(rootVariables['--fg'], '#222');
  assert.equal(rootVariables['--bg'], '#fff');
});

test('inline style declarations keep their offsets', () => {
  const value = 'color: #333; background : #fff';
  const decls = parseInlineStyle(value, 100);
  const color = decls.find((d) => d.prop === 'color');
  assert.equal(color.value, '#333');
  assert.equal(value.slice(color.valueStart - 100, color.valueEnd - 100).trim(), '#333');
  assert.ok(
    decls.some((d) => d.prop === 'background'),
    'whitespace before the colon must be tolerated',
  );
});

test('only selectors whose effect can be decided are accepted', () => {
  // Ancestry is a fact in the parsed markup, so `.card .btn` is decidable and accepted.
  // State, attributes and sibling order are not, so the rest stay refused — and refused
  // means the declaration is left out, never guessed at.
  for (const ok of ['.btn', '#main', 'p', 'p.lead', '.card .btn', 'nav > a', '.a.b .c']) {
    assert.notEqual(parseSelector(ok), null, `should be supported: ${ok}`);
  }
  for (const no of ['.btn:hover', 'a[href^="http"]', '*', '.a + .b', '.a ~ .b', 'p::before', '> p']) {
    assert.equal(parseSelector(no), null, `should be refused: ${no}`);
  }
  // Specificity is the a-b-c triple, so an id beats any number of classes.
  assert.ok(parseSelector('#main').specificity > parseSelector('.a.b.c').specificity);
  assert.ok(parseSelector('.card .btn').specificity > parseSelector('.btn').specificity);
});

test('relative lengths return undefined rather than a guess', () => {
  assert.equal(lengthToPx('16px'), 16);
  assert.equal(lengthToPx('1.5rem'), 24);
  // A guess here would silently reclassify body text as "large text" and lower the
  // contrast threshold from 4.5 to 3, turning a real failure into a pass.
  assert.equal(lengthToPx('1.2em'), undefined);
  assert.equal(lengthToPx('120%'), undefined);
  assert.equal(lengthToPx('calc(1rem + 2px)'), undefined);
  assert.equal(lengthToPx('inherit'), undefined);
});

test('bold detection follows the CSS keywords, not just numbers', () => {
  assert.equal(isBoldWeight('700'), true);
  assert.equal(isBoldWeight('bold'), true);
  assert.equal(isBoldWeight('bolder'), true);
  assert.equal(isBoldWeight('600'), false);
  assert.equal(isBoldWeight('normal'), false);
  assert.equal(isBoldWeight(''), false);
});

test('Tailwind colour tokens resolve to the palette', () => {
  assert.equal(resolveTailwindColor('gray-400'), '#9ca3af');
  assert.equal(resolveTailwindColor('white'), '#ffffff');
  assert.equal(resolveTailwindColor('black'), '#000000');
  assert.equal(resolveTailwindColor('[#123456]'), '#123456');
  // An opacity modifier is part of the colour. Discarding it reads bg-green-500/10 as
  // solid green, which invents contrast failures that do not render.
  assert.equal(resolveTailwindColor('slate-900/50'), 'rgba(15, 23, 42, 0.5)');
  assert.equal(resolveTailwindColor('black/[0.06]'), 'rgba(0, 0, 0, 0.06)');
  assert.equal(resolveTailwindColor('white/[6%]'), 'rgba(255, 255, 255, 0.06)');
  assert.equal(resolveTailwindColor('gray-400/100'), resolveTailwindColor('gray-400'));
  assert.equal(resolveTailwindColor('lg'), undefined);
  assert.equal(resolveTailwindColor('nonsense-999'), undefined);
});

test('a class list resolves colour and typography together', () => {
  const d = resolveTailwindClasses('text-gray-400 bg-white text-2xl font-bold');
  assert.equal(d.color, '#9ca3af');
  assert.equal(d.background, '#ffffff');
  assert.equal(d.fontSizePx, 24);
  assert.equal(d.bold, true);
});

test('a conditional variant does not decide an element unconditionally', () => {
  // `dark:text-white` says nothing about the default rendering. Folding it in is how a
  // checker reports failures for a combination that never appears together.
  const d = resolveTailwindClasses('text-gray-400 dark:text-white hover:text-black md:text-red-500');
  assert.equal(d.color, '#9ca3af');
});

test('nearestShade finds the closest shade in a family', () => {
  assert.equal(nearestShade('gray', '#9ca3af'), '400');
  assert.equal(nearestShade('gray', '#000000'), '950');
  assert.equal(nearestShade('nosuchfamily', '#000000'), undefined);
  assert.equal(nearestShade('gray', 'not-a-hex'), undefined);
});

test('familyOf reads the colour family off a utility class', () => {
  assert.equal(familyOf('text-gray-400'), 'gray');
  assert.equal(familyOf('bg-emerald-500/70'), 'emerald');
  assert.equal(familyOf('border-slate-200'), 'slate');
  assert.equal(familyOf('flex'), undefined);
  assert.equal(familyOf('text-white'), undefined);
});

/**
 * Character references are decoded, not blanked.
 *
 * `textOf` replaced `&[a-z]+;` with a space, which makes two spellings of one character
 * disagree about whether an element has any text. obrnadzor.gov.ru serves
 * `<button class="swipe-btn prev">&lt;</button>`, and the report said it "has no text
 * content" — a sentence anyone can falsify by opening the page.
 */

const analyse = (source) =>
  analyseSource('page.html', source, { rules: ALL_RULES, level: 'AA', fixThreshold: null });
const doc = (body) =>
  `<!DOCTYPE html><html lang="ru"><head><title>т</title></head><body><main><h1>з</h1>${body}</main></body></html>`;
const ids = (body) => analyse(doc(body)).violations.map((v) => v.ruleId);

test('three spellings of one character agree about whether a button has a name', () => {
  const answers = ['&times;', '\u00d7', '&#215;', '&#xD7;'].map((text) =>
    ids(`<button type="button">${text}</button>`).includes('A11Y-FORM-004'),
  );
  assert.deepEqual(
    answers,
    [false, false, false, false],
    'a button whose text is a visible character has a name, however it is written',
  );
});

test('the live case: a pager button whose text is an escaped angle bracket', () => {
  assert.ok(!ids('<button class="swipe-btn prev">&lt;</button>').includes('A11Y-FORM-004'));
});

test('a button holding nothing but whitespace references is still nameless', () => {
  // What shm.ru's forty-odd unnamed close buttons depend on. Decoding &nbsp; to U+00A0
  // preserves this, because JavaScript's trim() treats it as whitespace.
  for (const blank of ['&nbsp;', '&ensp;&emsp;', '&#160;', '   ']) {
    assert.ok(
      ids(`<button type="button">${blank}</button>`).includes('A11Y-FORM-004'),
      `"${blank}" is not a name`,
    );
  }
});

test('a reference the table does not know is left alone rather than blanked', () => {
  // Erring toward "this element has text" is the direction that stays quiet.
  assert.ok(!ids('<button type="button">&notarealentity;</button>').includes('A11Y-FORM-004'));
});

test('decoding happens after tags come out, not before', () => {
  // `&lt;div&gt;` decoded first would become `<div>` and be stripped as markup the author
  // never wrote, taking the button's only text with it.
  assert.ok(!ids('<button type="button">&lt;div&gt;</button>').includes('A11Y-FORM-004'));
});

test('a numeric reference for a lone surrogate is not turned into one', () => {
  // Half a character in a client-facing report line is worse than the escape itself.
  const found = analyse(doc('<button type="button">&#55296;</button>')).violations;
  for (const v of found) {
    assert.ok(!/[\uD800-\uDFFF]/.test(v.excerpt), 'no lone surrogate may reach an excerpt');
  }
});

test('a paginated link written with entity arrows is not empty', () => {
  // &laquo;/&raquo; pagers are ordinary Russian CMS output.
  assert.ok(!ids('<a href="/page/2/">&raquo;</a>').includes('A11Y-LINK-001'));
});
