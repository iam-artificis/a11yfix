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
