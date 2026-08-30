import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { selectStylesheets, referencedStylesheets } from '../dist/design/scope.js';
import { importedFrom, isDocumentRootComponent } from '../dist/parse/imports.js';
import { parseMarkup } from '../dist/parse/markup.js';
import { resolveTailwindColor } from '../dist/design/tailwind.js';
import { contrastRatio, parseColor } from '../dist/color.js';
import { matchesGlob, isIgnored } from '../dist/config.js';

/**
 * Every case here is a false positive this tool actually produced against a real,
 * well-maintained repository. None of them showed up on a synthetic fixture, which is the
 * point: the failure mode of a static analyser is not crashing, it is being confidently
 * wrong about code nobody wrote for it. These are the regressions worth guarding.
 */

const run = (file, source, opts = {}) =>
  analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: null, ...opts });

const contrastFindings = (result) => result.violations.filter((v) => v.ruleId.startsWith('A11Y-COLOR'));

test('a translucent background is composited, not read as solid', () => {
  // shadcn-ui/ui, registry/bases/*/examples/table-example.tsx: a status pill written as
  // `bg-green-500/10 text-green-700`. Reading the background as solid green-500 made it
  // 2.20:1 and failing. Composited over white it is about 4.9:1 and passes. Eighteen of
  // twenty-five contrast findings on that repository came from this one mistake.
  const source = `<html><body>
  <span class="bg-green-500/10 text-green-700 text-xs">Active</span>
</body></html>`;
  assert.deepEqual(contrastFindings(run('pill.html', source)), []);
});

test('a translucent background over a dark parent is still evaluated', () => {
  // The compositing must not become a blanket excuse: white/10 over slate-900 is a real
  // dark surface, and light-grey text on it genuinely fails.
  const source = `<html><body>
  <div class="bg-slate-900">
    <div class="bg-white/10"><span class="text-slate-700">Barely there</span></div>
  </div>
</body></html>`;
  const found = contrastFindings(run('dark.html', source));
  assert.equal(found.length, 1, 'a real failure on a composited surface must still be reported');
});

test('a stylesheet from another package does not colour this file', () => {
  // shadcn-ui/ui: `body { background-color: red }` in packages/shadcn/test/fixtures/…
  // was applied to templates/astro-monorepo/…, producing five error-severity findings
  // about a colour that appears nowhere near that file.
  const sheets = [
    { file: 'packages/other/test/fixtures/app/other.css', content: 'body { background-color: red; color: #fff }', scope: 'packages/other/test/fixtures/app' },
  ];
  const picked = selectStylesheets('apps/web/src/pages/index.astro', '<html><body><p>Hi</p></body></html>', sheets);
  assert.deepEqual(picked, [], 'a sheet from an unrelated package must not be consulted');
});

test('a stylesheet in the same package is consulted', () => {
  const sheets = [{ file: 'apps/web/src/app.css', content: 'body { color: #999 }', scope: 'apps/web' }];
  const picked = selectStylesheets('apps/web/src/pages/index.astro', '<p>Hi</p>', sheets);
  assert.equal(picked.length, 1);
});

test('a stylesheet the file imports is consulted across a package boundary', () => {
  const source = `import "@workspace/ui/globals.css";\n<html><body><p>Hi</p></body></html>`;
  const sheets = [
    { file: 'packages/ui/src/styles/globals.css', content: ':root { --x: 1 }', scope: 'packages/ui' },
  ];
  const picked = selectStylesheets('apps/web/src/pages/index.astro', source, sheets);
  assert.equal(picked.length, 1, 'an explicit import is evidence the sheet reaches this file');
});

test('when several packages share a stylesheet name, the nearest one wins', () => {
  const source = `import "./globals.css";`;
  const sheets = [
    { file: 'apps/other/globals.css', content: 'body { color: #111 }', scope: 'apps/other' },
    { file: 'apps/web/styles/globals.css', content: 'body { color: #222 }', scope: 'apps/web/styles' },
  ];
  const picked = selectStylesheets('apps/web/src/page.tsx', source, sheets);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].file, 'apps/web/styles/globals.css');
});

test('stylesheet references are read from imports, links and @import', () => {
  const found = referencedStylesheets(`
    import './a.css';
    import styles from "@pkg/b.scss";
    <link rel="stylesheet" href="/assets/c.css">
    @import url(d.css);
  `);
  assert.ok(found.has('a.css'));
  assert.ok(found.has('b.scss'));
  assert.ok(found.has('c.css'));
  assert.ok(found.has('d.css'));
});

test('an uppercase JSX tag is a component, not the element of the same name', () => {
  // documenso: <Html> from @react-email/components is an email wrapper that sets its own
  // language. Twenty-eight "the <html> element has no lang attribute" findings, all false.
  const email = `import { Body, Head, Html } from '../components';

export const Template = () => (
  <Html>
    <Head />
    <Body><p>Hello</p></Body>
  </Html>
);`;
  const langFindings = run('email.tsx', email).violations.filter((v) => v.ruleId === 'A11Y-DOC-001');
  assert.deepEqual(langFindings, [], 'an unknown component must not be asserted to be the document root');
});

test('but next/document really is the document root', () => {
  // The same tag name from a module we do know about is the single most common place
  // this bug appears in a Next.js application, and losing it would gut the rule.
  const doc = `import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html>
      <Head />
      <body><Main /><NextScript /></body>
    </Html>
  );
}`;
  const langFindings = run('_document.tsx', doc).violations.filter((v) => v.ruleId === 'A11Y-DOC-001');
  assert.equal(langFindings.length, 1, 'a missing lang on next/document must still be reported');
});

test('import bindings are resolved through every spelling', () => {
  const source = `
    import Default from 'mod-a';
    import { Named } from 'mod-b';
    import { Original as Renamed } from 'mod-c';
    import * as NS from 'mod-d';
  `;
  assert.equal(importedFrom(source, 'Default'), 'mod-a');
  assert.equal(importedFrom(source, 'Named'), 'mod-b');
  assert.equal(importedFrom(source, 'Renamed'), 'mod-c');
  assert.equal(importedFrom(source, 'NS.Thing'), 'mod-d');
  assert.equal(importedFrom(source, 'Unknown'), undefined);
  assert.equal(isDocumentRootComponent(`import { Html } from "next/document";`, 'Html'), true);
  assert.equal(isDocumentRootComponent(`import { Html } from "../components";`, 'Html'), false);
});

test('markup inside a template literal is not the page', () => {
  // tailwindcss.com: every "document has no lang" finding came from a `dedent` block
  // showing readers what an index.html looks like.
  const docs = `import dedent from 'dedent';

export const step = {
  code: dedent\`
    <!doctype html>
    <html>
      <head><script src="x.js"></script></head>
      <body><img src="a.png"></body>
    </html>
  \`,
};

export const Component = () => <p>Real markup</p>;`;
  const result = run('page.tsx', docs);
  assert.deepEqual(
    result.violations.filter((v) => v.ruleId === 'A11Y-DOC-001' || v.ruleId === 'A11Y-IMG-001'),
    [],
    'a code sample is not the page it describes',
  );
  const markup = parseMarkup(docs, { skipTemplateLiterals: true });
  assert.ok(markup.elements.some((e) => e.tagLower === 'p'), 'real JSX after a literal must still be seen');
  assert.ok(!markup.elements.some((e) => e.tagLower === 'html'), 'markup inside the literal must be masked');
});

test('a lit-html template really is markup', () => {
  const lit = 'const t = html`<img src="a.png">`;';
  const markup = parseMarkup(lit, { skipTemplateLiterals: true });
  assert.ok(markup.elements.some((e) => e.tagLower === 'img'));
});

test('a template literal with interpolation ends where it really ends', () => {
  const source = 'const a = `${ fn(`${inner}`) } text`;\n<img src="b.png">';
  const markup = parseMarkup(source, { skipTemplateLiterals: true });
  assert.equal(markup.elements.filter((e) => e.tagLower === 'img').length, 1);
});

test('text over a background image is not measured against an assumed colour', () => {
  // shadcn-ui/ui remix-indie-stack: a hero with <img> and a scrim behind white text,
  // inside a <main class="bg-white">. Read literally that is white on white.
  const hero = `<html><body>
  <main class="bg-white">
    <div class="relative">
      <div class="absolute inset-0"><img src="hero.jpg" alt="Stage"></div>
      <div class="relative"><p class="text-white">Over the photo</p></div>
    </div>
  </main>
</body></html>`;
  assert.deepEqual(contrastFindings(run('hero.html', hero)), []);
});

test('a stretched sibling that paints nothing does not silence the file', () => {
  // A focus ring or an invisible click target is also `absolute inset-0`, and treating
  // those as an overlay would quietly disable contrast checking across a codebase.
  const source = `<html><body>
  <div class="bg-white">
    <div class="absolute inset-0 ring-1"></div>
    <p class="text-gray-400">Muted copy</p>
  </div>
</body></html>`;
  assert.equal(contrastFindings(run('ring.html', source)).length, 1);
});

test('a gradient background stops the ancestor walk instead of being skipped', () => {
  const source = `<html><body>
  <div class="bg-white">
    <div class="bg-gradient-to-r"><p class="text-gray-200">On a gradient</p></div>
  </div>
</body></html>`;
  assert.deepEqual(
    contrastFindings(run('grad.html', source)),
    [],
    'a gradient is not a colour, and the white behind it is not what the text sits on',
  );
});

test('invisible text against a merely assumed background is not a finding', () => {
  // cal.com: a Next.js _document.tsx containing no colours at all was reported as
  // white-on-white at 1.00:1, because a stylesheet set the text colour and nothing in
  // the file declared a background.
  const source = `<html><body style="color:#ffffff"><p>Hello</p></body></html>`;
  assert.deepEqual(contrastFindings(run('doc.html', source)), []);
});

test('muted grey on an assumed white page is still a finding', () => {
  // The guard above must stay narrow: this is the single most common real contrast bug
  // on the web and it also relies on the default background.
  const source = `<html><body><p style="color:#bbbbbb">Muted copy</p></body></html>`;
  assert.equal(contrastFindings(run('muted.html', source)).length, 1);
});

test('one duplicated id is one finding', () => {
  // shadcn-ui/ui: four <Input id="radius"> in one demo produced four paragraphs, all
  // describing the same collision.
  const source = `<html><body>
  <input id="radius"><input id="radius"><input id="radius"><input id="radius">
</body></html>`;
  const dupes = run('demo.html', source).violations.filter((v) => v.ruleId === 'A11Y-DOC-006');
  assert.equal(dupes.length, 1);
  assert.match(dupes[0].message, /4 times/);
});

test('an unnamed decorative svg is not reported, an unnamed role="img" svg is', () => {
  // 102 findings across two production sites, none actionable: a browser does not expose
  // a role-less inline svg as an image. Claiming otherwise buried the real cases.
  const decorative = `<html><body><button>Save <svg viewBox="0 0 16 16"><path d="M0 0"/></svg></button></body></html>`;
  assert.deepEqual(
    run('icon.html', decorative).violations.filter((v) => v.ruleId === 'A11Y-IMG-006'),
    [],
  );

  const claimed = `<html><body><svg role="img" viewBox="0 0 16 16"><path d="M0 0"/></svg></body></html>`;
  assert.equal(
    run('graphic.html', claimed).violations.filter((v) => v.ruleId === 'A11Y-IMG-006').length,
    1,
  );
});

test('the ratio a fix claims to reach is the ratio it reaches', () => {
  // The description used to quote the solver's ideal colour rather than the palette step
  // actually written, so a patch that reaches 4.83:1 was advertised as reaching 3.01:1.
  // A number in a report that nobody can reproduce is worse than no number.
  const source = `<html><body>
  <div class="bg-white">
    <h2 class="text-gray-400 text-2xl font-bold">Heading</h2>
    <p class="text-gray-400">Body copy</p>
    <span class="text-emerald-500">Status</span>
  </div>
</body></html>`;
  const found = contrastFindings(run('claims.html', source));
  assert.ok(found.length >= 3);
  for (const v of found) {
    const claim = /reaching ([\d.]+):1/.exec(v.fix?.description ?? '');
    if (claim === null) continue;
    const swap = /Replace (\S+) with (\S+),/.exec(v.fix.description);
    assert.ok(swap !== null, 'a claimed ratio must come with the class it applies to');
    const shade = swap[2].replace(/^(?:text|bg|border)-/, '');
    const hex = resolveTailwindColor(shade);
    const actual = contrastRatio(parseColor(hex), parseColor('#ffffff'));
    assert.ok(
      Math.abs(actual - Number(claim[1])) < 0.01,
      `${v.fix.description} — ${swap[2]} actually reaches ${actual.toFixed(2)}:1`,
    );
  }
});

test('a fix is only offered when a palette step really clears the threshold', () => {
  const source = `<html><body>
  <div class="bg-white"><p class="text-gray-400">Body copy</p></div>
</body></html>`;
  for (const v of contrastFindings(run('verify.html', source))) {
    for (const edit of v.fix?.edits ?? []) {
      const applied = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
      const after = contrastFindings(run('verify.html', applied));
      assert.deepEqual(after, [], 'applying the offered fix must clear the finding it was offered for');
    }
  }
});

test('a Vue single-file component is understood, not just tolerated', () => {
  const sfc = `<script setup lang="ts">
const html = "<div>not markup</div>";
</script>

<template>
  <div class="bg-white p-6">
    <p class="text-gray-400">Muted copy.</p>
    <div @click="toggle" class="cursor-pointer">Toggle</div>
    <input v-model="q" placeholder="Search products" />
  </div>
</template>`;
  const ids = new Set(run('Card.vue', sfc).violations.map((v) => v.ruleId));
  assert.ok(ids.has('A11Y-COLOR-001'), 'Tailwind colours inside <template> must resolve');
  assert.ok(ids.has('A11Y-KBD-002'), '@click must be recognised as a handler');
  assert.ok(ids.has('A11Y-FORM-002'), 'a placeholder-only label must be found');
  // Markup inside the <script> block is a string, not part of the component.
  assert.equal(
    run('Card.vue', sfc).violations.filter((v) => v.line <= 3).length,
    0,
    'nothing in the script block is markup',
  );
});

test('a Svelte component is understood, not just tolerated', () => {
  const svelte = `<script lang="ts">
  const html = "<div>not markup</div>";
</script>

<div class="bg-white p-6">
  <img src="/logo.png" />
  <div on:click={() => (open = !open)}>Toggle</div>
  {#if open}
    <p class="text-gray-400">Muted copy.</p>
  {/if}
</div>`;
  const ids = new Set(run('Card.svelte', svelte).violations.map((v) => v.ruleId));
  assert.ok(ids.has('A11Y-IMG-001'));
  assert.ok(ids.has('A11Y-KBD-002'), 'on:click must be recognised as a handler');
  assert.ok(ids.has('A11Y-COLOR-001'), 'markup inside {#if} must still be analysed');
});

test('a stylesheet is parsed once per run, not once per file', () => {
  // Parsing in the Palette constructor meant 70 stylesheets times 3334 files: 230,000
  // parses of text that never changed, and 23 of a 25-second scan. The shape of the bug
  // is quadratic, so the guard is a bound that only a quadratic implementation exceeds.
  const sheets = Array.from({ length: 40 }, (_, i) => ({
    file: `pkg/s${i}.css`,
    content: Array.from({ length: 120 }, (_, r) => `.c${i}_${r} { color: #33${(r % 10)}${(r % 10)}44; background: #fff }`).join('\n'),
    scope: 'pkg',
  }));
  const source = '<html><body><div class="c0_0"><p class="c1_1">Text</p></div></body></html>';

  const started = Date.now();
  for (let i = 0; i < 300; i++) run(`pkg/page${i}.html`, source, { stylesheets: sheets });
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 8000,
    `300 files against 40 stylesheets took ${elapsed}ms; the sheets are being re-parsed`,
  );
});

test('a decorative separator is not text with a contrast problem', () => {
  // tailwindcss.com: a <span class="text-pink-300">&middot;</span> between two pieces of
  // metadata. Technically text, practically a bullet, and nobody is going to darken a dot
  // — a finding nobody acts on costs the credibility of the ones beside it.
  const source = `<html><body>
  <div class="bg-white">
    <span class="text-gray-500">128 reviews</span>
    <span class="text-pink-300">&middot;</span>
    <span class="text-pink-300">|</span>
    <span class="text-pink-300">Bayfield, ON</span>
  </div>
</body></html>`;
  const found = contrastFindings(run('meta.html', source));
  assert.equal(found.length, 1, 'only the span with real words should be reported');
  assert.match(found[0].excerpt, /Bayfield|text-pink-300">Bayfield|<span/);
  assert.ok(found[0].line >= 6, `expected the last span, got line ${found[0].line}`);
});

test('a glob matches the paths people actually write in an ignore list', () => {
  const cases = [
    ['apps/web/public/flags/index.html', 'apps/web/public/**', true],
    ['apps/web/public/index.html', '**/public/**', true],
    ['apps/web/src/index.html', '**/public/**', false],
    ['src/Button.stories.tsx', '**/*.stories.tsx', true],
    ['src/Button.tsx', '**/*.stories.tsx', false],
    ['vendor/lib/a.html', 'vendor', true],
    ['src/vendor/lib/a.html', 'vendor', true],
    ['src/vendored.html', 'vendor', false],
    ['a/b/c.html', 'a/*/c.html', true],
    ['a/b/d/c.html', 'a/*/c.html', false],
    ['a/b/d/c.html', 'a/**/c.html', true],
    ['x.html', '**/x.html', true],
    // Regex metacharacters in a path must not become a pattern.
    ['src/(app)/page.tsx', 'src/(app)/**', true],
    ['src/xappx/page.tsx', 'src/(app)/**', false],
  ];
  for (const [path, pattern, expected] of cases) {
    assert.equal(
      matchesGlob(path, pattern),
      expected,
      `${JSON.stringify(pattern)} against ${JSON.stringify(path)}`,
    );
  }
});

test('ignore patterns are resolved against the config, not the working directory', () => {
  assert.equal(isIgnored('/repo/apps/web/public/a.html', ['apps/web/public/**'], '/repo'), true);
  assert.equal(isIgnored('/repo/apps/web/src/a.html', ['apps/web/public/**'], '/repo'), false);
  assert.equal(isIgnored('/repo/a.html', [], '/repo'), false);
});

test('a rule turned off produces no findings', () => {
  const source = `<html><body><img src="a.png"><p style="color:#bbb">hi</p></body></html>`;
  const all = run('t.html', source);
  assert.ok(all.violations.some((v) => v.ruleId === 'A11Y-IMG-001'));

  const off = run('t.html', source, { disabled: new Set(['A11Y-IMG-001']) });
  assert.ok(!off.violations.some((v) => v.ruleId === 'A11Y-IMG-001'));
  // Disabling one rule must not disturb the others.
  assert.ok(off.violations.some((v) => v.ruleId === 'A11Y-COLOR-001'));
});

test('a disable comment hides one finding, not the rule', () => {
  const source = `<!DOCTYPE html>
<html lang="en">
<head><title>T</title></head>
<body><main>
  <h1>Images</h1>
  <!-- a11yfix-disable-next-line A11Y-IMG-001 -->
  <img src="divider.png">
  <img src="hero.png">
</main></body>
</html>`;
  const result = run('page.html', source);
  const missingAlt = result.violations.filter((v) => v.ruleId === 'A11Y-IMG-001');
  assert.equal(missingAlt.length, 1, 'only the suppressed line should be hidden');
  assert.equal(missingAlt[0].line, 8);
  assert.equal(result.suppressed, 1);
});

test('a disable comment naming no rule hides everything on that line', () => {
  const source = `<html><body>
  <!-- a11yfix-disable-next-line -->
  <img src="a.png">
  <img src="b.png">
</body></html>`;
  const ids = run('t.html', source).violations.filter((v) => v.line === 3);
  assert.deepEqual(ids, []);
});

test('a disable comment for a rule that no longer fires is reported', () => {
  // Otherwise suppressions accumulate until nobody knows which are load-bearing.
  const source = `<html><body>
  <!-- a11yfix-disable-next-line A11Y-IMG-001 -->
  <img src="a.png" alt="A cat on a mat">
</body></html>`;
  const result = run('t.html', source);
  assert.deepEqual(result.unusedSuppressions, [2]);
});

test('disable-file applies to the whole file and disable-line to its own line', () => {
  const perLine = `<html><body>
  <img src="a.png"> <!-- a11yfix-disable-line A11Y-IMG-001 -->
  <img src="b.png">
</body></html>`;
  assert.equal(run('t.html', perLine).violations.filter((v) => v.ruleId === 'A11Y-IMG-001').length, 1);

  const wholeFile = `<!-- a11yfix-disable-file A11Y-IMG-001 -->
<html><body>
  <img src="a.png">
  <img src="b.png">
</body></html>`;
  assert.equal(run('t.html', wholeFile).violations.filter((v) => v.ruleId === 'A11Y-IMG-001').length, 0);
});

test('a JSX comment works as a suppression too', () => {
  const source = `export const A = () => (
  <div>
    {/* a11yfix-disable-next-line A11Y-IMG-001 */}
    <img src="divider.png" />
    <img src="hero.png" />
  </div>
);`;
  const found = run('A.tsx', source).violations.filter((v) => v.ruleId === 'A11Y-IMG-001');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 5);
});
