import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { parseMarkup } from '../dist/parse/markup.js';
import { matchesGlob } from '../dist/config.js';
import { importedFrom } from '../dist/parse/imports.js';

/**
 * Four quadratic loops and two exponential regexes, each of which a plausible input
 * reaches.
 *
 * The bounds below are deliberately loose — a hundredfold above what the fixed code
 * takes — because a wall-clock assertion that runs on other people's machines has to
 * fail only for a real change in complexity. Every case here took hundreds of
 * milliseconds to seconds before, and would blow the bound by orders of magnitude if the
 * quadratic behaviour came back.
 *
 * These are the ones no unit test would have found, because each is correct at every
 * size a fixture is written at. They came out of a review that read for complexity
 * rather than for behaviour.
 */

const within = (ms, label, fn) => {
  const t0 = process.hrtime.bigint();
  const result = fn();
  const took = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(took < ms, `${label} took ${took.toFixed(0)}ms, budget ${ms}ms`);
  return result;
};

const page = (body, head = '') =>
  `<!DOCTYPE html><html lang="en"><head><title>t</title>${head}</head>` +
  `<body><main><h1>h</h1>${body}</main></body></html>`;

const analyse = (source) =>
  analyseSource('p.html', source, { rules: ALL_RULES, level: 'AA', fixThreshold: null });

test('a list written without closing tags parses in linear time', () => {
  // Legal HTML, and what most generators emit. Every <li> used to scan to the end of the
  // document looking for a </li> that is not there: 4000 items, 425ms, in the tokeniser
  // alone and before a single rule ran.
  const body = '<ul>' + Array.from({ length: 4000 }, (_, i) => `<li>item ${i}`).join('') + '</ul>';
  const markup = within(1000, 'parseMarkup on 4000 unclosed <li>', () => parseMarkup(page(body)));
  assert.equal(markup.elements.filter((e) => e.tagLower === 'li').length, 4000);
});

test('a file with many findings reports them in linear time', () => {
  // positionAt counted newlines from byte 0 for every violation, so a first run on a
  // neglected file walked the file once per finding.
  const body = Array.from({ length: 1600 }, (_, i) => `<img src="a${i}.png">`).join('\n');
  const result = within(1500, 'analyse with 1600 findings', () => analyse(page(body)));
  assert.equal(result.violations.filter((v) => v.ruleId === 'A11Y-IMG-001').length, 1600);
  // The line numbers are still right, which is the only reason the index is allowed.
  const first = result.violations.find((v) => v.ruleId === 'A11Y-IMG-001');
  assert.equal(first.line, 1);
  const last = [...result.violations].reverse().find((v) => v.ruleId === 'A11Y-IMG-001');
  assert.equal(last.line, 1600);
});

test('a flat document does not compare every sibling to every other', () => {
  // A changelog, a search-results page, a table of contents: 2000 children of one node.
  const body =
    '<div>' +
    Array.from(
      { length: 2000 },
      (_, i) => `<p style="color:#999999;background:#ffffff;font-size:14px">t${i}</p>`,
    ).join('') +
    '</div>';
  const result = within(2000, 'contrast on 2000 flat siblings', () => analyse(page(body)));
  assert.equal(result.violations.filter((v) => v.ruleId === 'A11Y-COLOR-001').length, 2000);
});

test('a large stylesheet is indexed, not rescanned per element', () => {
  const head = '<style>' + Array.from({ length: 800 }, (_, i) => `.c${i}{color:#333333}`).join('') + '</style>';
  const body = Array.from({ length: 800 }, (_, i) => `<p class="c${i}" style="font-size:14px">t${i}</p>`).join('');
  within(1000, 'palette with 800 rules over 800 elements', () => analyse(page(body, head)));
});

test('an ignore pattern cannot hang the scan', () => {
  // Patterns come out of a user's config file. `**/**/…` is a plausible typo, and eight
  // of those groups took five seconds to *fail* on an ordinary path.
  const path = 'a/'.repeat(40) + 'other.tsx';
  within(200, 'matchesGlob with 40 ** segments', () =>
    assert.equal(matchesGlob(path, '**/'.repeat(40) + 'target.tsx'), false),
  );
  // And it still matches what it should.
  assert.equal(matchesGlob('apps/web/public/x.tsx', 'apps/**/public/**'), true);
  assert.equal(matchesGlob('apps/web/x.tsx', '**/*.tsx'), true);
  assert.equal(matchesGlob('apps/web/x.tsx', '**/**/*.tsx'), true);
  assert.equal(matchesGlob('src/a.ts', 'src/*.tsx'), false);
});

test('whitespace between import and from cannot hang the scan', () => {
  const source = 'import' + ' '.repeat(4000) + 'Foo\n';
  within(200, 'importedFrom on a long whitespace run', () => importedFrom(source, 'Foo'));

  // Still resolves what it should.
  assert.equal(importedFrom(`import { Html } from 'next/document';`, 'Html'), 'next/document');
  assert.equal(importedFrom(`import Doc, { Html as H } from "next/document";`, 'H'), 'next/document');
  assert.equal(importedFrom(`import * as NS from 'mod';`, 'NS'), 'mod');
  assert.equal(importedFrom(`const Html = () => null;`, 'Html'), undefined);
});

test('many raw-text elements do not re-copy the file', () => {
  // Each <style>, <script>, <textarea>, <title> and <pre> lowercased the whole source to
  // find its own closing tag.
  const body = Array.from({ length: 400 }, (_, i) => `<style>.a${i}{color:#111111}</style>`).join('\n');
  const markup = within(1000, 'parseMarkup with 400 <style> blocks', () => parseMarkup(page(body)));
  assert.equal(markup.elements.filter((e) => e.tagLower === 'style').length, 400);
});
