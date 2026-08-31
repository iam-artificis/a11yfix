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
  assert.equal(isBoldWeight('lighter'), false);
});

test('a weight we cannot decide is undefined, which is not the same as normal', () => {
  // Returning false here is worse than saying nothing: it stops the inheritance walk, so
  // a span reading `font-weight: inherit` inside a bold heading counted as normal weight
  // and was held to 4.5:1 when 3:1 was the threshold that applied to it.
  for (const value of ['inherit', 'unset', 'revert', 'var(--w)', 'calc(400 + 300)', '']) {
    assert.equal(isBoldWeight(value), undefined, `${value} is not decidable here`);
  }
});

test('the !important flag never reaches the weight test', () => {
  // The declaration parser strips it and records it separately, so 'bold !important'
  // arrives as 'bold'. This is the parse, not the string, so the guarantee is checked
  // where it is made.
  const [d] = parseCss('.a{font-weight:bold !important}').rules[0].declarations;
  assert.equal(d.value, 'bold');
  assert.equal(d.important, true);
  assert.equal(isBoldWeight(d.value), true);
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

/**
 * Elements HTML lets you leave unclosed.
 *
 * `</li>` has been optional since HTML 2. A theatre's front page written that way had its
 * every `<li>` collapsed to zero length, which handed each item's `<a>` and its nested
 * submenu to the enclosing `<ul>` — and A11Y-DOC-007 then reported twenty-four times that
 * a list contained something other than a list item, about markup that is entirely
 * correct. The tests below fix both halves of the answer: which elements get an implied
 * end, and which deliberately do not.
 */

test('a list item with no closing tag keeps its own children', () => {
  const source = '<ul><li><a href="/a/">A</a><ul><li>deep</li></ul><li><a href="/b/">B</a></ul>';
  const { elements } = parse(source);
  const items = elements.filter((e) => e.tagLower === 'li');
  const first = items[0];
  const link = elements.find((e) => getAttr(e, 'href')?.value === '/a/');
  const inner = elements.filter((e) => e.tagLower === 'ul')[1];
  assert.equal(link.parent, first, 'the <a> belongs to the <li> it was written inside');
  assert.equal(inner.parent, first, 'so does the submenu');
  assert.ok(first.end > first.openEnd, 'the item has extent, not zero length');
});

test('the live case: an unclosed menu is not reported as a malformed list', () => {
  const source =
    '<ul class="nav"><li><a href="/o/">О театре</a><ul class="sub"><li><a href="/x/">X</a></ul>' +
    '<li><a href="/afisha/">Афиша</a></ul>';
  assert.ok(
    !ids(source).includes('A11Y-DOC-007'),
    'omitting </li> is valid HTML and must not be reported as a list containing a non-item',
  );
});

test('each element with an optional end tag is ended by the right sibling', () => {
  const cases = [
    ['<dl><dt>term<dd>definition<dt>next</dl>', 'dt', 2],
    ['<select><option>a<option>b<option>c</select>', 'option', 3],
    ['<table><tr><td>a<td>b<tr><td>c</table>', 'td', 3],
    ['<div><p>one<p>two<div>three</div></div>', 'p', 2],
  ];
  for (const [source, tag, count] of cases) {
    const { elements } = parse(source);
    const found = elements.filter((e) => e.tagLower === tag);
    assert.equal(found.length, count, `${tag} count in ${source}`);
    for (const el of found) {
      assert.ok(el.end > el.openEnd, `<${tag}> in ${source} should have extent`);
    }
  }
});

test('a <p> is ended by the block that follows it, not by the next inline element', () => {
  const { elements } = parse('<div><p>text<span>inside</span><div>after</div></div>');
  const p = elements.find((e) => e.tagLower === 'p');
  const span = elements.find((e) => e.tagLower === 'span');
  const after = elements.filter((e) => e.tagLower === 'div')[1];
  assert.equal(span.parent, p, 'a <span> does not close a <p>');
  assert.notEqual(after.parent, p, 'a <div> does');
});

test('a tag outside that list is left collapsed rather than guessed at', () => {
  // The deliberate limit. A source file is full of things that only look like tags:
  // `ComponentProps<typeof Sidebar>` tokenises as an element named `typeof`, and giving
  // it extent makes it the parent of every list item after it — nine invented findings
  // across shadcn's sidebars. An unclosed <div> loses the same way, so neither is guessed.
  const { elements } = parse('<Wrapper><div class="never-closed"><ul><li>a</li></ul>');
  const div = elements.find((e) => e.tagLower === 'div');
  const list = elements.find((e) => e.tagLower === 'ul');
  assert.equal(div.end, div.openEnd, 'an unclosed <div> is not extended');
  assert.notEqual(list.parent, div, 'so it does not adopt what follows it');
});

test('a self-closing textarea does not swallow the rest of the file', () => {
  // <textarea> holds raw text, so the search for an enclosing element's closing tag has
  // to step over its body. In JSX it is often written `<textarea … />` with no body and
  // no closing tag at all; hunting for one ran to the end of the file, and the <label>
  // wrapped around it was then reported as never closed — so the field inside it had no
  // label, and the <form> around that had no fields.
  const source = '<form><label>Body <textarea name="b" rows={8} /></label><button>Go</button></form>';
  const { elements } = parse(source);
  const label = elements.find((e) => e.tagLower === 'label');
  const area = elements.find((e) => e.tagLower === 'textarea');
  const button = elements.find((e) => e.tagLower === 'button');
  assert.ok(label.end > label.openEnd, 'the <label> is closed where it says it is');
  assert.equal(area.parent, label, 'the field is inside its label');
  assert.ok(button !== undefined, 'and the rest of the form is still parsed');
});

test('a textarea that does have a body still hides its contents', () => {
  const { elements } = parse('<div><textarea><p>literal</p></textarea><span>after</span></div>');
  assert.equal(
    elements.filter((e) => e.tagLower === 'p').length,
    0,
    'text inside a textarea is text, not markup',
  );
  const span = elements.find((e) => e.tagLower === 'span');
  const div = elements.find((e) => e.tagLower === 'div');
  assert.equal(span.parent, div, 'and the element around it still closes');
});

test('items with implied ends are siblings, not a chain of ancestors', () => {
  // The end offset alone is not enough: nothing pops an element that has no closing tag,
  // so without an explicit sweep each <li> adopts the one after it and a ten-item menu
  // reports as ten levels of nesting.
  const { elements } = parse('<ul><li>a<li>b<li>c</ul>');
  const items = elements.filter((e) => e.tagLower === 'li');
  const list = elements.find((e) => e.tagLower === 'ul');
  for (const li of items) {
    assert.equal(li.parent, list, 'every item hangs off the list itself');
    assert.equal(li.depth, list.depth + 1, 'and sits one level below it');
  }
  assert.equal(list.children.length, 3, 'the list has three children, not one');
});

test('@layer does not make the rules inside it conditional', () => {
  // Tailwind v4 emits the whole design system inside @layer. Treating that as a condition
  // marks every rule "might not apply" and leaves a modern build with no readable colours
  // at all. @layer changes which cascade layer a rule sits in, not whether it applies.
  const { rules } = parseCss('@layer base { .a { color: #111111 } } @media print { .b { color: #222222 } }');
  const a = rules.find((r) => r.selector === '.a');
  const b = rules.find((r) => r.selector === '.b');
  assert.deepEqual(a.conditions, [], '@layer is not a condition');
  assert.equal(b.conditions.length, 1, '@media still is');
});

test('a rule nested in both keeps only the condition that is one', () => {
  const { rules } = parseCss('@layer u { @media (min-width: 40rem) { .c { color: #333333 } } }');
  const c = rules.find((r) => r.selector === '.c');
  assert.equal(c.conditions.length, 1);
  assert.match(c.conditions[0], /@media/);
});

test('the group stack still balances when layers nest', () => {
  const { rules } = parseCss('@layer a { @layer b { .x { color: #000000 } } } .y { color: #ffffff }');
  const y = rules.find((r) => r.selector === '.y');
  assert.ok(y !== undefined, 'a rule after two closed layers is still found');
  assert.deepEqual(y.conditions, []);
});
