import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';

/**
 * A11Y-DOC-016 exists because of one commercial fact: in the Russian market the answer
 * to ГОСТ Р 52872-2019 is usually a «версия для слабовидящих» switch, and the site owner
 * believes the standard is therefore met. The rule's whole job is to say, in the same
 * report as the real findings, what that switch does and does not do.
 *
 * That makes two properties load-bearing, and they pull in opposite directions:
 *
 *  - it has to fire on the widgets people actually install, under the three shapes they
 *    arrive in — vendor script, injected panel markup, hand-wired link;
 *  - it must not fire on ordinary pages. It is `info`, so a false positive costs the
 *    reader's trust rather than a broken build, and trust is the thing being sold.
 */

const run = (file, source) =>
  analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: null });

const overlays = (file, source) =>
  run(file, source).violations.filter((v) => v.ruleId === 'A11Y-DOC-016');

const page = (body, head = '') =>
  `<!DOCTYPE html><html lang="ru"><head><title>Т</title>${head}</head><body><main><h1>З</h1>${body}</main></body></html>`;

test('the hand-wired Russian switch is found by its text', () => {
  const found = overlays('p.html', page('<a href="#" onclick="bvi()">Версия для слабовидящих</a>'));
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  // No criterion: having an overlay breaks no success criterion. Claiming one would be
  // the same overreach the rule is written against.
  assert.deepEqual([...found[0].wcag], []);
});

test('it reads aria-label and title, not only the visible text', () => {
  assert.equal(
    overlays('p.html', page('<button aria-label="Версия для слабовидящих">👁</button>')).length,
    1,
  );
  assert.equal(overlays('p.html', page('<a href="/x" title="Специальная версия">A</a>')).length, 1);
});

test('vendor assets are found by URL, whatever the filename', () => {
  // Real paths. The bvi ones are from shm.ru, which ships four of these on one page:
  // stylesheet, script, and two buttons.
  const urls = [
    'https://acsbapp.com/apps/app/dist/js/app.js',
    'https://cdn.userway.org/widget.js',
    'https://ws.audioeye.com/ae.js',
    '/local/templates/new-gim/js/bvi.min.js',
    '/local/templates/new-gim/css/bvi.min.css',
    '/js/bvi/init.js',
    'https://slabovid.ru/widget/v2/w.js',
  ];
  for (const url of urls) {
    const found = overlays('p.html', page('<p>т</p>', `<script src="${url}"></script>`));
    assert.equal(found.length, 1, `not detected: ${url}`);
    assert.match(found[0].message, /URL contains/);
  }
});

test('webvisor is not bvi', () => {
  // Yandex Metrica ships `webvisor` — which contains the letters b, v, i in order — to a
  // very large share of exactly the sites this rule is aimed at. A bare substring match
  // would have reported the analytics tag on most of the Russian corpus.
  const yandex = page(
    '<p>т</p>',
    '<script src="https://mc.yandex.ru/metrika/tag.js"></script>' +
      '<script>ym(1, "init", { webvisor: true });</script>',
  );
  assert.deepEqual(overlays('p.html', yandex), []);
});

test('the switch as a submit input, which is how a CMS theme renders it', () => {
  // spbu.ru, verbatim: a Drupal form submit whose only label is its value.
  const found = overlays(
    'p.html',
    page('<form><input type="submit" id="switchtheme-submit" value="Версия для слабовидящих"></form>'),
  );
  assert.equal(found.length, 1);
});

test('a handler makes an element a control; prose is not one', () => {
  assert.equal(overlays('p.html', page('<span onclick="Spec()">Версия для слабовидящих</span>')).length, 1);
  assert.equal(overlays('p.html', page('<div @click="spec">Специальная версия сайта</div>')).length, 1);
  // A wrapper with a handler must not drag a whole article into the match.
  const article =
    '<div onclick="track()"><p>Библиотека много лет обслуживает слабовидящих читателей и ' +
    'располагает фондом изданий, напечатанных шрифтом Брайля, а также тифлотехникой для ' +
    'самостоятельного чтения.</p></div>';
  assert.deepEqual(overlays('p.html', page(article)), []);
});

test('the panel a widget injects is found by its class', () => {
  assert.equal(overlays('p.html', page('<div class="bvi-panel bvi-open">…</div>')).length, 1);
});

test('one element is reported once, however many ways it matches', () => {
  const found = overlays(
    'p.html',
    page('<button class="bvi-open" aria-label="Версия для слабовидящих">Версия для слабовидящих</button>'),
  );
  assert.equal(found.length, 1);
});

test('an ordinary page says nothing about overlays', () => {
  const quiet = [
    page('<a href="/about">О нас</a><img src="a.png" alt="фото"><script src="/js/app.js"></script>'),
    // Words that are near the trigger but are not an offer to restyle the page.
    page('<p>Наша библиотека обслуживает слабовидящих читателей с 1962 года.</p>'),
    page('<a href="/accessibility">Accessibility statement</a>'),
    page('<div class="visually-hidden">skip</div><span class="sr-only">меню</span>'),
    // Ordinary utility classes and scripts. Note what is not asserted here: a URL
    // containing "bvi-" is treated as the widget, because in practice it is one
    // (js/bvi-1.3.1/bvi.js is a common shape) and no library shares the prefix.
    page('<script src="/js/vendor/chart.js"></script>'),
  ];
  for (const source of quiet) {
    assert.deepEqual(
      overlays('p.html', source).map((v) => v.message),
      [],
      source.slice(0, 90),
    );
  }
});

test('a component is left alone', () => {
  // <AccessibilityWidget /> may render anything; we cannot see its props.
  assert.equal(overlays('App.jsx', '<AccessibilityWidget label="Версия для слабовидящих" />').length, 0);
});

test('it carries advice and no edits, and never claims the widget should go', () => {
  const found = overlays('p.html', page('<a href="#" onclick="b()">Версия для слабовидящих</a>'));
  const fix = found[0].fix;
  assert.equal(fix.safety, 'manual');
  assert.deepEqual(fix.edits, [], 'an overlay is not something to patch out of a page');
  assert.ok(fix.advisory.length > 0);
  assert.doesNotMatch(fix.advisory, /\bremove\b(?!\s+it —)/i);
  // The FTC order is public record (Jan 2025 complaint, final April 2025, $1M) and is
  // the reason the sentence is worth writing at all. If it is ever softened, it should
  // be softened deliberately, not by a passing edit.
  assert.match(fix.advisory, /Federal Trade Commission/);
});

test('the sample report shows the widget the sample page has', async () => {
  const source = await readFile(new URL('../demo/uchrezhdenie.ru.html', import.meta.url), 'utf8');
  const found = overlays('demo/uchrezhdenie.ru.html', source);
  assert.equal(found.length, 1, 'the fixture is the report shown to buyers; it must demonstrate this');
});

test('a site\'s own low-vision page is not evidence that it installed a widget', () => {
  // "для слабовидящих" transliterates to a path containing the substring "slabovid", so
  // every Russian institution's canonical link matched a vendor name. This reported a
  // widget on pages that have none.
  const canonical = '<link rel="canonical" href="https://shm.ru/dostupnyy-muzey/dlyaslabovidyashchikh/">';
  assert.deepEqual(overlays('p.html', page('<p>т</p>', canonical)), []);
  const alt = '<link rel="alternate" hreflang="ru" href="/dlyaslabovidyashchikh/">';
  assert.deepEqual(overlays('p.html', page('<p>т</p>', alt)), []);
});

test('the vendor at slabovid.ru is still found', () => {
  // The other half: dropping the name entirely would have lost a real vendor.
  const found = overlays('p.html', page('<p>т</p>', '<script src="https://slabovid.ru/widget/v2/w.js"></script>'));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /URL contains/);
});

test('a stylesheet link is still read', () => {
  // The rel filter must not switch the rule off for the way overlays actually arrive.
  const css = '<link rel="stylesheet" href="/local/templates/new-gim/css/bvi.min.css">';
  assert.equal(overlays('p.html', page('<p>т</p>', css)).length, 1);
});
