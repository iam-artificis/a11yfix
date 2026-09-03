import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { parseMarkup } from '../dist/parse/markup.js';
import { TODO_MARKER } from '../dist/types.js';

/**
 * These tests enforce the promises the README makes. They are the reason a developer can
 * point this at a repository they care about: not because the rules are clever, but
 * because the tool provably will not fabricate text or rewrite an expression.
 */

const run = (file, source, opts = {}) =>
  analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: null, ...opts });

test('every rule has a stable id, a title and a summary', () => {
  const seen = new Set();
  for (const rule of ALL_RULES) {
    assert.match(rule.id, /^A11Y-[A-Z]+-\d{3}$/, `bad rule id: ${rule.id}`);
    assert.ok(!seen.has(rule.id), `duplicate rule id: ${rule.id}`);
    seen.add(rule.id);
    assert.ok(rule.title.length > 0, `${rule.id} has no title`);
    assert.ok(rule.summary.length > 0, `${rule.id} has no summary`);
    assert.ok(rule.appliesTo.length > 0, `${rule.id} applies to nothing`);
  }
});

test('no fix invents alternative text, link text or a language code', () => {
  const source = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <img src="hero.png">
  <a href="/x"><span></span></a>
  <a href="/y" aria-label=""></a>
  <button><svg viewBox="0 0 1 1"></svg></button>
  <input type="text">
  <input type="email" placeholder="e.g. jane@example.com">
  <input type="submit" value="">
  <select></select>
  <div role="img" class="logo"></div>
  <iframe src="/embed"></iframe>
</body>
</html>`;
  // markTodos, or the marker-writing fixes are never selected and the sweep walks past
  // the exact rules whose job is to write into a name position. A placeholder-only
  // <input> is in the fixture for the same reason: A11Y-FORM-002 used to copy
  // placeholder="e.g. jane@example.com" into aria-label, which this test claims cannot
  // happen, and no fixture ever gave it the chance to.
  const result = run('page.html', source, { markTodos: true });
  assert.ok(result.violations.length > 0, 'expected findings on deliberately broken markup');

  for (const v of result.violations) {
    if (v.fix === undefined) continue;
    for (const edit of v.fix.edits) {
      // Anything written into an accessible-name position must be an obvious placeholder.
      const namesSomething = /\b(alt|aria-label|title|lang)\s*=/.test(edit.replacement);
      if (!namesSomething) continue;
      // An empty value invents nothing. alt="" says "this image is decorative" and
      // lang="" says "language unknown" — both are standard values with defined
      // meanings, and neither puts words in the author's mouth. Anything with content
      // in it still has to be an obvious placeholder.
      const emptyValue = /\b(?:alt|aria-label|title|lang)\s*=\s*""/.test(edit.replacement);
      const marked = edit.replacement.includes(TODO_MARKER);
      assert.ok(
        emptyValue || marked,
        `${v.ruleId} wrote a name without a ${TODO_MARKER} marker: ${edit.replacement}`,
      );
    }
  }
});

test('no fix rewrites a dynamic attribute value', () => {
  const source = `export const A = () => (
  <div>
    <img src={hero} alt={caption} />
    <a href={url} target="_blank">{label}</a>
    <div style={{ color: muted }}>text</div>
    <input aria-label={t('name')} />
  </div>
);`;
  const result = run('A.tsx', source);
  const markup = parseMarkup(source);
  const dynamicRanges = markup.elements.flatMap((el) =>
    el.attrs.filter((a) => a.dynamic || a.quote === '{').map((a) => [a.valueStart, a.valueEnd]),
  );

  for (const v of result.violations) {
    for (const edit of v.fix?.edits ?? []) {
      for (const [start, end] of dynamicRanges) {
        const overlaps = edit.start < end && edit.end > start;
        assert.ok(!overlaps, `${v.ruleId} edited a dynamic value at ${start}-${end}`);
      }
    }
  }
});

test('document-level rules stay quiet on a component fragment', () => {
  // A React component is not a page. Reporting "no <h1>" or "missing lang" on every
  // component file is the fastest way to make a tool unusable on a real codebase.
  const fragment = `export function Badge() {
  return <span className="badge">New</span>;
}`;
  const result = run('Badge.tsx', fragment);
  const documentRules = result.violations.filter((v) =>
    /missing|no h1|no <h1>|lang|title|landmark|skip/i.test(v.message),
  );
  assert.equal(
    documentRules.length,
    0,
    `document-level rules fired on a fragment: ${documentRules.map((v) => v.ruleId + ' ' + v.message).join('; ')}`,
  );
});

test('a clean document produces no error-severity findings', () => {
  const clean = `<!DOCTYPE html>
<html lang="en">
<head><title>About us</title></head>
<body>
  <a href="#main">Skip to content</a>
  <main id="main">
    <h1>About us</h1>
    <p style="color:#1a1a1a;background:#ffffff">We build things.</p>
    <img src="team.jpg" alt="The team standing outside the office">
    <label for="email">Email address</label>
    <input id="email" type="email" autocomplete="email">
    <button type="submit">Subscribe</button>
  </main>
</body>
</html>`;
  const result = run('clean.html', clean);
  const errors = result.violations.filter((v) => v.severity === 'error');
  assert.equal(
    errors.length,
    0,
    `clean document produced errors: ${errors.map((v) => `${v.ruleId}: ${v.message}`).join('; ')}`,
  );
});

test('every violation carries evidence a human can check', () => {
  const source = `<html><body><img src="a.png"><p style="color:#bbb">hi</p></body></html>`;
  const result = run('t.html', source);
  assert.ok(result.violations.length > 0);
  for (const v of result.violations) {
    assert.ok(v.line >= 1, `${v.ruleId} has no line`);
    assert.ok(v.column >= 1, `${v.ruleId} has no column`);
    assert.ok(v.message.length > 0, `${v.ruleId} has no message`);
    assert.ok(v.impact.length > 0, `${v.ruleId} does not say who is affected`);
    assert.ok(v.start <= v.end, `${v.ruleId} has an inverted range`);
    assert.ok(v.end <= source.length, `${v.ruleId} points past the end of the file`);
  }
});

test('applying automatic fixes never produces a syntactically broken document', () => {
  const source = `<!DOCTYPE html>
<html>
<body>
  <img src="a.png">
  <img src="b.png" />
  <meta name="viewport" content="width=device-width, user-scalable=no">
  <a href="/x" target="_blank">Docs</a>
  <div tabindex="3">focusable</div>
</body>
</html>`;
  const fixed = run('t.html', source, { fixThreshold: 'review' }).fixedSource;
  assert.ok(fixed !== undefined);
  // Tag count must be preserved: a fix that eats or invents a tag has corrupted the file.
  const before = parseMarkup(source).elements.length;
  const after = parseMarkup(fixed).elements.length;
  assert.equal(after, before, 'element count changed after applying fixes');
  assert.ok(!fixed.includes('<<') && !fixed.includes('>>'), 'fix produced malformed brackets');
  assert.ok(!/=\s*=/.test(fixed), 'fix produced a doubled equals sign');
});

test('the analyser survives hostile and malformed input', () => {
  const nasty = [
    '<div class="' + 'a'.repeat(50000) + '">x</div>',
    '<'.repeat(5000),
    '<div>'.repeat(2000),
    '<img src=<<<<>>>>>',
    '<a href="\u0000\u001b[31m">x</a>',
    '<div style="color:' + 'rgb('.repeat(500) + '">x</div>',
    '<!-- ' + 'x'.repeat(10000),
    '<div {...spread} {...more}>text</div>',
  ];
  for (const source of nasty) {
    const started = Date.now();
    const result = run('nasty.html', source, { fixThreshold: 'automatic' });
    const elapsed = Date.now() - started;
    assert.ok(result !== undefined);
    assert.ok(elapsed < 5000, `analysis took ${elapsed}ms on hostile input`);
  }
});

test('fix safety levels are respected', () => {
  const source = `<html><body><meta name="viewport" content="width=device-width, user-scalable=no"><div tabindex="5">x</div></body></html>`;
  const auto = run('t.html', source, { fixThreshold: 'automatic' });
  const review = run('t.html', source, { fixThreshold: 'review' });
  // Anything applied at the automatic level must also be applied at the review level.
  assert.ok(
    review.appliedFixes >= auto.appliedFixes,
    'review threshold applied fewer fixes than automatic',
  );
  for (const v of auto.violations) {
    if (v.fix?.advisory !== undefined) {
      assert.equal(v.fix.edits.length, 0, `${v.ruleId} carries both advice and edits`);
    }
  }
});

test('a fix either patches or advises, never both', () => {
  // An advisory means "the tool declined to patch", and fixAllowed enforces that by
  // refusing any fix carrying one. So a rule that ships edits *and* an advisory has
  // silently shipped edits that nothing can ever apply — which is how every
  // marker-writing fix in the tool came to be unreachable while the README sold the
  // mechanism.
  const sources = {
    'page.html': `<!DOCTYPE html><html><head></head><body>
      <img src="a.png"><a href="/x"><span></span></a><a href="/y" aria-label=""></a>
      <button><svg viewBox="0 0 1 1"></svg></button><input type="text">
      <input type="email" placeholder="Email"><select></select>
      <div role="img" class="logo"></div><iframe src="/e"></iframe>
      <p style="color:#aaaaaa;background:#ffffff;font-size:14px">low contrast</p>
      <div onclick="go()">clickable</div><table><tr><td>1</td></tr></table>
      </body></html>`,
    'C.tsx': `export const C = () => (<div className="bg-white">
      <p className="text-gray-400">faint</p><a onClick={go}>Go</a>
      <img src={src} /><input placeholder="Search…" /></div>);`,
  };
  for (const [file, source] of Object.entries(sources)) {
    for (const v of run(file, source).violations) {
      if (v.fix === undefined) continue;
      assert.ok(
        !(v.fix.edits.length > 0 && v.fix.advisory !== undefined),
        `${v.ruleId} carries ${v.fix.edits.length} edits and an advisory, so the edits are dead`,
      );
    }
  }
});


/**
 * The corrected line printed in the report.
 *
 * It is the most persuasive thing in a URL audit — the buyer cannot apply a diff, and one
 * line they can retype is the whole deliverable — which makes it the most expensive place
 * to be wrong. Two promises hold it up: it never appears for a change the tool would not
 * write, and it is the real result of the real edits, not a sentence about them.
 */

const CORPUS = [
  ['a.html', '<html><body><img src="a.png"><p style="color:#bbb">hi</p></body></html>'],
  [
    'b.html',
    '<!doctype html><html><head><title>t</title></head><body><main><h1>H</h1>' +
      '<span onclick="go()">Go</span><a href="/x" target="_blank">Docs</a>' +
      '<li onclick="pick()">Pick</li><input type="text" name="email">' +
      '<button></button><a href="/y"><img src="i.png"></a></main></body></html>',
  ],
  [
    'c.jsx',
    'export const A = () => (<div onClick={go}><img src="x.png" />' +
      '<a href={url} target="_blank">go</a></div>);',
  ],
];

test('a corrected line is offered only where the tool would really write the change', () => {
  let offered = 0;
  for (const [file, source] of CORPUS) {
    for (const v of run(file, source).violations) {
      if (v.excerptFixed === undefined) continue;
      offered++;
      assert.notEqual(v.fix, undefined, `${v.ruleId} shows a corrected line with no fix`);
      assert.notEqual(
        v.fix.safety,
        'manual',
        `${v.ruleId} shows a corrected line for a change it will not write`,
      );
      assert.equal(
        v.fix.advisory,
        undefined,
        `${v.ruleId} shows a corrected line for advice, which is a suggestion, not a change`,
      );
      assert.ok(v.fix.edits.length > 0);
    }
  }
  assert.ok(offered > 0, 'the corpus should exercise this at all');
});

test('the corrected line is the result of the edits, not a description of them', () => {
  for (const [file, source] of CORPUS) {
    for (const v of run(file, source).violations) {
      if (v.excerptFixed === undefined) continue;
      const stop = Math.min(v.end, v.start + 160);
      let raw = source.slice(v.start, stop);
      for (const e of [...v.fix.edits].sort((a, b) => b.start - a.start)) {
        assert.ok(e.start >= v.start && e.end <= stop, `${v.ruleId}: edit outside the window`);
        raw = raw.slice(0, e.start - v.start) + e.replacement + raw.slice(e.end - v.start);
      }
      const expected = raw.replace(/\s+/g, ' ').trim();
      const shown = v.excerptFixed.replace(/…$/, '');
      assert.ok(
        expected.startsWith(shown),
        `${v.ruleId}: shown "${shown}" is not what applying the edits produces`,
      );
    }
  }
});

test('a finding a person has to decide shows no corrected line', () => {
  // The whole promise of this tool in one assertion: it does not know what the image
  // shows, so it must not print a line that claims to.
  const r = run('t.html', '<html><body><img src="a.png"></body></html>');
  const alt = r.violations.find((v) => v.ruleId === 'A11Y-IMG-001');
  assert.notEqual(alt, undefined);
  assert.equal(alt.excerptFixed, undefined);
});

test('a corrected line never contains a TODO marker', () => {
  // --mark-todos writes placeholders that fail CI on purpose. Printing one in a client
  // report as "after the change" would hand somebody a marker to paste into their page.
  for (const [file, source] of CORPUS) {
    for (const v of run(file, source, { markTodos: true }).violations) {
      if (v.excerptFixed === undefined) continue;
      assert.ok(
        !v.excerptFixed.includes(TODO_MARKER),
        `${v.ruleId} would show a TODO marker as the corrected line`,
      );
    }
  }
});

test('a field named after a prototype member is data, not a lookup', () => {
  // TYPE_TOKENS and NAME_TOKENS are object literals, so they answer for every name on
  // Object.prototype. `<input type="constructor">` found the Object constructor, passed
  // the `!== undefined` test, and produced a review-safety fix offering to write
  // autocomplete="function Object() { [native code] }" into the source; the name form
  // reached .endsWith on a function and threw, taking the whole file's findings with it.
  const cases = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'];
  for (const word of cases) {
    for (const attr of ['type', 'name', 'id']) {
      const source =
        `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main><h1>h</h1>` +
        `<form><label for="f">Field</label><input id="f" ${attr}="${word}">` +
        `<button type="submit">Go</button></form></main></body></html>`;
      const result = run('t.html', source, { fixThreshold: 'review' });
      for (const v of result.violations) {
        for (const edit of v.fix.edits) {
          assert.ok(
            !/native code|function Object/.test(edit.replacement),
            `${attr}="${word}" produced ${edit.replacement}`,
          );
        }
      }
    }
  }
});

test('a report line never ends in half a character', () => {
  // truncate() and short() count UTF-16 units, so a cut that lands between the halves of
  // an astral character leaves a lone surrogate — a replacement glyph in a line the
  // client is reading. Emoji at every offset around the cut, so one of them straddles it.
  for (let pad = 0; pad < 8; pad++) {
    const text = 'a'.repeat(pad) + '\u{1F600}'.repeat(60);
    const source =
      `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main><h1>h</h1>` +
      `<a href="/x/">${text}</a><img src="a.png" alt="image of ${text}">` +
      `</main></body></html>`;
    for (const v of run('t.html', source).violations) {
      const fields = [v.message, v.impact, v.fix.description, v.fix.advisory, v.excerpt];
      for (const field of fields) {
        if (typeof field !== 'string') continue;
        assert.ok(
          !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(field) &&
            !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(field),
          `lone surrogate in ${v.ruleId}: ${JSON.stringify(field.slice(-20))}`,
        );
      }
    }
  }
});

test('a TODO marker in an href is not also reported as a broken fragment link', () => {
  // A11Y-KBD-009 patches `<a onclick=…>` with href="#A11YFIX-TODO": the marker makes the
  // element focusable and fails CI until a human writes the real destination. A11Y-TODO-001
  // reports it and says exactly that. A11Y-LINK-008 used to report it a second time as
  // "no element in this document has that id", whose repair — point it at an element that
  // exists — is not the repair. Applying our own patch must not manufacture a finding.
  const source =
    `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Тест</title></head>` +
    `<body><main><h1>Заголовок</h1><a onclick="open()">Подробнее</a></main></body></html>`;
  const patched = analyseSource('page.html', source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: 'manual',
    markTodos: true,
  }).fixedSource;
  assert.ok(patched.includes(`href="#${TODO_MARKER}"`), 'the patch should plant the marker');

  const after = run('page.html', patched).violations;
  assert.equal(
    after.filter((v) => v.ruleId === 'A11Y-LINK-008').length,
    0,
    'the marker is not a broken fragment; it is an unfinished destination',
  );
  assert.ok(
    after.some((v) => v.ruleId === 'A11Y-TODO-001'),
    'and the marker is still reported, by the rule that owns it',
  );
});


test('a click-away handler does not make a container a control', () => {
  // Alpine's .away modifier binds the listener to the document: @click.away="open = false"
  // closes a dropdown when the user clicks *anywhere but here*. The element is what is
  // being clicked away from. mxat.ru wraps three menus in exactly this, correct as
  // written, and the tool called each one "a control by appearance only".
  for (const attr of ['@click.away', '@click.outside', 'v-on:click.away']) {
    const source =
      '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main><h1>h</h1>' +
      `<ul><li ${attr}="open = false">Menu</li></ul></main></body></html>`;
    const found = run('page.html', source).violations.filter((v) => v.ruleId === 'A11Y-KBD-002');
    assert.equal(found.length, 0, `${attr} is not a click handler on this element`);
  }
});

test('a real click handler beside a click-away one is still reported', () => {
  // The guard must skip the .away attribute, not the element: a dropdown that both opens
  // on click and closes on click-away still needs to be reachable.
  const source =
    '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main><h1>h</h1>' +
    '<div @click.away="open = false" @click="open = true">Menu</div></main></body></html>';
  const found = run('page.html', source).violations.filter((v) => v.ruleId === 'A11Y-KBD-002');
  assert.equal(found.length, 1);
});

test('no rule judges the placeholder a patch wrote as if a person had written it', () => {
  // Three rules used to. LINK-006 read seven identical markers as "one name, seven
  // destinations"; LINK-009 read two placeholder hrefs as one destination repeated and
  // advised merging the links; LINK-008 read the marker as a fragment with no target.
  // Each is our own text, and A11Y-TODO-001 already reports it saying the useful thing.
  const source =
    '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Тест</title></head>' +
    '<body><main><h1>Заголовок</h1>' +
    '<a href="https://vk.com/x"><img src="a.svg"></a>' +
    '<a href="https://ok.ru/y"><img src="b.svg"></a>' +
    '<a onclick="a()">Раз</a><a onclick="b()">Два</a>' +
    '</main></body></html>';
  const patched = analyseSource('page.html', source, {
    rules: ALL_RULES, level: 'AA', fixThreshold: 'manual', markTodos: true,
  }).fixedSource;
  assert.ok(patched.includes(TODO_MARKER), 'the patch should plant markers');

  const after = run('page.html', patched).violations;
  for (const id of ['A11Y-LINK-006', 'A11Y-LINK-008', 'A11Y-LINK-009']) {
    assert.equal(
      after.filter((v) => v.ruleId === id).length, 0,
      `${id} fired on a placeholder this tool wrote`,
    );
  }
  assert.ok(after.some((v) => v.ruleId === 'A11Y-TODO-001'), 'the markers are still reported');
});

test('a file the analyser cannot read is a finding about that file, not the end of the run', () => {
  // Parsing and colour resolution used to sit above the guard that protects rule
  // execution, so a throw there ended the whole run. `background: constructor` did it:
  // the process exited 2 and every other file in the repository went unscanned, with no
  // output at all. Both halves are asserted here — that this input no longer throws, and
  // that if something ever does, one file is what is lost.
  const poisoned = [
    '<!doctype html><html lang="en"><head><title>t</title>',
    '<style>.a { background: constructor; } .b { background: __proto__; }</style>',
    '</head><body><main><p class="a">x</p><p class="b">y</p></main></body></html>',
  ].join('');
  const result = run('poisoned.html', poisoned);
  assert.ok(Array.isArray(result.violations));
  assert.equal(
    result.violations.some((v) => v.ruleId === 'A11Y-META-001'),
    false,
    'a prototype key in a stylesheet is ordinary unsupported input, not a failure',
  );
});

/**
 * A criterion next to a finding is a citation, and a wrong one is worse than none.
 *
 * It borrows the standard's authority for a claim the standard does not make, and the
 * reader most likely to check — somebody holding a conformance obligation — is exactly
 * the reader who will find it. Four rules used to cite a criterion that did not fit the
 * finding they were attached to; each is asserted here against the case that decides it.
 */
const doc = (body) =>
  '<!doctype html><html lang="en"><head><title>t</title></head><body><main>' +
  body +
  '</main></body></html>';

const cite = (source, ruleId) =>
  run('t.html', doc(source))
    .violations.filter((v) => v.ruleId === ruleId)
    .map((v) => ({ severity: v.severity, wcag: [...v.wcag] }));

test('a duplicate id is a WCAG failure only when something resolves it', () => {
  // 4.1.1 Parsing, which used to cover duplicate ids outright, was removed in WCAG 2.2.
  // What remains is the case the impact text actually describes: a reference resolving
  // to the first match and stopping, so one control borrows another's name.
  assert.deepEqual(cite('<p id="x">a</p><p id="x">b</p>', 'A11Y-DOC-006'), [
    { severity: 'warning', wcag: [] },
  ]);
  assert.deepEqual(
    cite('<p id="x">a</p><p id="x">b</p><button aria-labelledby="x">go</button>', 'A11Y-DOC-006'),
    [{ severity: 'error', wcag: ['1.3.1', '4.1.2'] }],
  );
  assert.deepEqual(cite('<label for="x">N</label><input id="x"><input id="x">', 'A11Y-DOC-006'), [
    { severity: 'error', wcag: ['1.3.1', '4.1.2'] },
  ]);
  // A #fragment link resolves the id too, but nothing about a name or a relationship
  // breaks: the link lands on the first of them, which is a bug with no criterion.
  assert.deepEqual(cite('<a href="#x">go</a><p id="x">a</p><p id="x">b</p>', 'A11Y-DOC-006'), [
    { severity: 'warning', wcag: [] },
  ]);
});

test('a radio group without a name is 1.3.1; a checkbox without one is not', () => {
  // Radios sharing no name are not a group, and the grouping relationship is exactly
  // what 1.3.1 is about. A checkbox with no name submits nothing — a defect in the form
  // with no barrier behind it.
  assert.deepEqual(cite('<form><input type="radio"><input type="radio"></form>', 'A11Y-FORM-003'), [
    { severity: 'warning', wcag: ['1.3.1'] },
    { severity: 'warning', wcag: ['1.3.1'] },
  ]);
  assert.deepEqual(
    cite('<form><input type="checkbox" id="c"><label for="c">x</label></form>', 'A11Y-FORM-003'),
    [{ severity: 'warning', wcag: [] }],
  );
});

test('captions are 1.2.2 for video and 1.2.1 for audio-only', () => {
  // 1.2.2 Captions (Prerecorded) is about synchronised media. Audio-only falls under
  // 1.2.1, where the remedy is a transcript rather than captions — which is what this
  // rule's own advice already said while it cited both criteria on both elements.
  assert.deepEqual(cite('<video src="v.mp4"></video>', 'A11Y-IMG-008'), [
    { severity: 'warning', wcag: ['1.2.2'] },
  ]);
  assert.deepEqual(cite('<audio src="a.mp3"></audio>', 'A11Y-IMG-008'), [
    { severity: 'warning', wcag: ['1.2.1'] },
  ]);
});

test('a fragment link with no target cites no criterion', () => {
  // 2.4.4 Link Purpose is about whether the link text says where it goes. A link whose
  // text is perfect and whose target does not exist passes it.
  assert.deepEqual(cite('<a href="#nope">go</a>', 'A11Y-LINK-008'), [
    { severity: 'warning', wcag: [] },
  ]);
});

test('a finding never cites a criterion its rule does not declare', () => {
  // Rules may cite a subset of what they declare — three of them decide per element.
  // Citing something outside the declaration is different: docs/coverage.md is built
  // from the declarations, so it would understate the tool in a file that promises not
  // to overstate it, and the drift would be invisible from either side.
  const byId = new Map(ALL_RULES.map((r) => [r.id, r]));
  const sources = [
    '<p id="x">a</p><p id="x">b</p><button aria-labelledby="x">go</button>',
    '<form><input type="radio"><input type="checkbox"></form>',
    '<video src="v.mp4"></video><audio src="a.mp3"></audio>',
    '<a href="#nope">go</a><a href="/x"><img src="i.png"></a>',
    '<table><tr><td>1</td></tr></table><iframe src="/x"></iframe>',
    '<span onclick="go()">press</span><input placeholder="Name">',
  ];
  let checked = 0;
  for (const source of sources) {
    for (const v of run('t.html', doc(source)).violations) {
      const rule = byId.get(v.ruleId);
      if (rule === undefined) continue; // A11Y-META-001 is emitted by the engine
      for (const sc of v.wcag) {
        checked++;
        assert.ok(
          rule.wcag.includes(sc),
          v.ruleId + ' cited ' + sc + ', which it does not declare',
        );
      }
    }
  }
  assert.ok(checked > 20, 'too few citations checked: ' + checked);
});
