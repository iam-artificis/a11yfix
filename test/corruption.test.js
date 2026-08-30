import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { parseMarkup } from '../dist/parse/markup.js';

/**
 * The one failure this tool must never have.
 *
 * A checker that misses a violation has wasted somebody's afternoon. A checker that
 * writes a broken file has cost them their working tree, and every claim in the README
 * about never guessing is worthless. So the invariant here is not about accuracy at all:
 * whatever the parser does or does not understand, an edit must land inside the element
 * it was computed for, and a construct the parser cannot read must produce no element at
 * all rather than one of unknown extent.
 *
 * These cases come from a real defect. `scanBraces` tracked quote state and nothing else,
 * so an apostrophe inside a comment in a JSX attribute expression put it in a string it
 * never left. It then returned `src.length` — "this expression runs to the end of the
 * file" — and the rules inserted `role="button"` at the module's final `}`. The emitted
 * patch applied cleanly and left a file that no longer parsed.
 */

/** A backtick, built rather than typed: these tests live inside template literals. */
const tick = String.fromCharCode(96);

const run = (file, source, opts = {}) =>
  analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: 'review', ...opts });

/** Sources that used to make the opening tag swallow the rest of the module. */
const SWALLOWERS = {
  'apostrophe in a line comment': `export function Toolbar() {
  return (
    <div className="toolbar">
      <div
        onClick={() => {
          // don't submit twice
          submit();
        }}
      >
        Save
      </div>
      <img src="/spinner.gif" />
    </div>
  );
}
`,
  'apostrophe in a block comment': `export function Toolbar() {
  return (
    <div className="toolbar">
      <div onClick={() => { /* the user's choice */ submit(); }}>
        Save
      </div>
      <img src="/spinner.gif" />
    </div>
  );
}
`,
  'apostrophe in a regex literal': `export function Toolbar() {
  return (
    <div className="toolbar">
      <div onClick={() => { if (/can't/.test(s)) submit(); }}>
        Save
      </div>
      <img src="/spinner.gif" />
    </div>
  );
}
`,
  'apostrophe in a string, which always worked': `export function Toolbar() {
  return (
    <div className="toolbar">
      <div onClick={() => go("it's fine")}>
        Save
      </div>
      <img src="/spinner.gif" />
    </div>
  );
}
`,
  'quote inside a spread expression': `export function Toolbar(props) {
  return (
    <div {...{ ...props, label: "don't" }}>
      <img src="/spinner.gif" />
    </div>
  );
}
`,
};

for (const [name, source] of Object.entries(SWALLOWERS)) {
  test(`no edit escapes its element: ${name}`, () => {
    const result = run('Toolbar.tsx', source);
    const elements = parseMarkup(source, { kind: 'jsx' }).elements;

    for (const v of result.violations) {
      for (const edit of v.fix?.edits ?? []) {
        // The tail of the module is `);\n}\n`. An edit reaching into it is the bug.
        assert.ok(
          edit.end <= source.lastIndexOf('  );'),
          `${v.ruleId} edits offset ${edit.end}, past the end of the JSX: ` +
            JSON.stringify(source.slice(edit.start, edit.end + 20)),
        );
        // Stronger: it has to fall inside some element the parser actually found.
        assert.ok(
          elements.some((el) => edit.start >= el.openStart && edit.end <= el.end),
          `${v.ruleId} edits outside every parsed element`,
        );
      }
    }
  });

  test(`the fixed source still closes every construct: ${name}`, () => {
    const result = run('Toolbar.tsx', source);
    const fixed = result.fixedSource ?? source;
    // A cheap structural check that catches the actual damage: the module's braces and
    // parentheses balanced before, so they must balance after.
    const count = (text, ch) => text.split(ch).length - 1;
    for (const [open, close] of [
      ['{', '}'],
      ['(', ')'],
    ]) {
      assert.equal(
        count(fixed, open) - count(fixed, close),
        count(source, open) - count(source, close),
        `${open}${close} balance changed`,
      );
    }
    assert.ok(fixed.trimEnd().endsWith('}'), 'the module no longer ends with its closing brace');
  });
}

test('an element nested behind an unreadable expression is still analysed', () => {
  // The secondary damage: everything inside the swallowed span went unreported, so a
  // missing alt on the very next line was silently invisible.
  const source = SWALLOWERS['apostrophe in a line comment'];
  const ids = run('Toolbar.tsx', source).violations.map((v) => v.ruleId);
  assert.ok(ids.includes('A11Y-IMG-001'), `the nested <img> was not reported: ${ids.join(', ')}`);
});

test('an expression that genuinely cannot be read produces no element, not a guess', () => {
  // An unterminated template literal really does run to the end of the file. The right
  // answer is to record nothing for that tag rather than an element of invented extent —
  // and to keep finding the elements inside it.
  const source = `export default function C() {
  return (
    <div title={\`unterminated
      <img src="a.png">
    </div>
  );
}
`;
  const elements = parseMarkup(source, { kind: 'jsx' }).elements;
  for (const el of elements) {
    assert.ok(el.openEnd <= source.length, 'element extends past the source');
    assert.ok(
      el.tagLower !== 'div' || el.openEnd < source.lastIndexOf('}'),
      'the unreadable div was recorded with an invented extent',
    );
  }
  assert.ok(
    elements.some((el) => el.tagLower === 'img'),
    'nested elements must still be found after an unreadable tag',
  );
});

test('a comment or regex in a brace does not hide the attributes after it', () => {
  const source = `export default function C() {
  return <div onClick={() => { /* don't */ go(); }} id="save">x</div>;
}
`;
  const el = parseMarkup(source, { kind: 'jsx' }).elements.find((e) => e.tagLower === 'div');
  assert.ok(el !== undefined, 'the div should be parsed');
  const names = el.attrs.map((a) => a.nameLower);
  assert.deepEqual(names, ['onclick', 'id'], `attributes lost: ${names.join(', ')}`);
});

test('a stray backtick in prose does not blank out the rest of the file', () => {
  // skipTemplate returned source.length for a literal it never found the end of, and the
  // caller masked that whole span. One backtick in a paragraph therefore hid everything
  // after it: the <label> below stopped being seen, so its input was reported as
  // unlabelled — a fabricated error — while every real finding past the backtick
  // disappeared without a word.
  const withTick = [
    'export function Consent() {',
    '  return (',
    '    <div>',
    '      <input id="tos" type="checkbox" />',
    '      <p>Press ` to jump here.</p>',
    '      <label htmlFor="tos">I accept the terms</label>',
    '    </div>',
    '  );',
    '}',
  ].join('\n');
  const withoutTick = withTick.replace('` ', '');

  const idsFor = (src) => run('Consent.tsx', src).violations.map((v) => v.ruleId).sort();
  assert.deepEqual(
    idsFor(withTick),
    idsFor(withoutTick),
    'a backtick in prose changed what the analyser can see',
  );
  assert.ok(
    !idsFor(withTick).includes('A11Y-FORM-001'),
    'the input is labelled two lines below; reporting it unlabelled is fabrication',
  );
});

test('a stray backtick does not silence findings that follow it', () => {
  const src = (prose) =>
    [
      'export function Help() {',
      '  return (',
      '    <main>',
      '      <h1>Help</h1>',
      `      <p>${prose}</p>`,
      '      <img src="/diagram.png" />',
      '    </main>',
      '  );',
      '}',
    ].join('\n');

  const clean = run('Help.tsx', src('Use the key.')).violations.map((v) => v.ruleId);
  const ticked = run('Help.tsx', src(`Use the ${tick} key.`)).violations.map((v) => v.ruleId);
  assert.ok(clean.includes('A11Y-IMG-001'), 'fixture should report the unlabelled image');
  assert.deepEqual(ticked.sort(), clean.sort(), 'the backtick swallowed real findings');
});

test('a template literal that is closed is still masked', () => {
  // The masking exists for a reason: markup inside a dedent`…` literal is a string, not
  // a document. Fixing the unterminated case must not stop the terminated one working.
  const source = [
    'const html = dedent' + tick + '',
    '  <img src="a.png">',
    '' + tick + ';',
    'export const C = () => <main><h1>x</h1></main>;',
  ].join('\n');
  const ids = run('C.tsx', source).violations.map((v) => v.ruleId);
  assert.ok(!ids.includes('A11Y-IMG-001'), 'markup inside a template literal is a string');
});

test('an attribute after a very long one is still seen', () => {
  // parseAttributes stopped at a fixed 20000-character bound and returned a truncated
  // list with no signal that anything was missing. An inline base64 image is enough to
  // exceed it, and the alt attribute sitting right after it was reported as absent.
  const big = 'A'.repeat(20900);
  const source =
    '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>h</h1>' +
    `<img src="data:image/png;base64,${big}" alt="Acme company logo">` +
    '</main></body></html>';
  const ids = run('page.html', source).violations.map((v) => v.ruleId);
  assert.ok(
    !ids.includes('A11Y-IMG-001'),
    'the alt attribute is in the source; reporting it missing is fabrication',
  );
});

test('a long attribute does not lead to a duplicate being written', () => {
  // The other half: with lang truncated away, --fix wrote a second lang="" beside the
  // correct one. In JSX a duplicate prop is a type error, and under Babel the later one
  // wins, so a correct lang="en" was overridden with an empty one.
  const big = 'A'.repeat(20900);
  const source =
    `<!doctype html><html data-theme="${big}" lang="en"><head><title>t</title></head>` +
    '<body><main><h1>h</h1></main></body></html>';
  const result = run('page.html', source);
  const fixed = result.fixedSource ?? source;
  assert.equal(
    (fixed.match(/\slang=/g) ?? []).length,
    1,
    'the document ended up with more than one lang attribute',
  );
});

test('an unterminated tag still cannot run away', () => {
  // The window has to keep bounding malformed input, or a pathological file becomes a
  // quadratic scan.
  const source = '<b '.repeat(20000);
  const started = Date.now();
  run('nasty.html', source);
  assert.ok(Date.now() - started < 2000, 'an unterminated tag took too long to parse');
});

test('JSX inside an attribute expression stays inside it', () => {
  // From shadcn-ui/ui. The render prop holds a whole element, and the '/>' that closes it
  // sits at the top level of the brace scan. Reading that slash as the start of a regex
  // made the surrounding <Button> unparseable, and the <a> inside then surfaced as a
  // top-level element with no accessible name — 116 false "empty link" findings on one
  // repository.
  const source = `export function V0Button({ url, title, className }) {
  return (
    <Button
      nativeButton={false}
      role="link"
      variant={isMobile ? "default" : "outline"}
      className={cn("h-[31px] gap-1 rounded-lg", className)}
      render={
        <a
          href={\`\${process.env.NEXT_PUBLIC_V0_URL}/chat/api/open?url=\${url}&title=\${title}\`}
          target="_blank"
        />
      }
    >
      <span>Open in</span>
    </Button>
  );
}
`;

  const tags = parseMarkup(source, { kind: 'jsx' }).elements.map((e) => e.tagLower);
  assert.ok(tags.includes('button'), `the Button did not parse: [${tags.join(', ')}]`);
  assert.ok(
    !tags.includes('a'),
    'an element inside an attribute expression must not become a top-level element',
  );

  const ids = run('v0-button.tsx', source).violations.map((v) => v.ruleId);
  assert.ok(!ids.includes('A11Y-LINK-001'), `false empty-link finding: ${ids.join(', ')}`);
});

test('division is not mistaken for a regex', () => {
  const source = `export default function C({ a, b }) {
  return <div style={{ width: a / b / 2 }} id="ratio">x</div>;
}
`;
  const el = parseMarkup(source, { kind: 'jsx' }).elements.find((e) => e.tagLower === 'div');
  assert.ok(el !== undefined, 'the div should still be parsed when the expression divides');
  assert.deepEqual(
    el.attrs.map((a) => a.nameLower),
    ['style', 'id'],
  );
});
