import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { renderReport } from '../dist/report.js';
import { RULE_TEXT_RU, pluralRu } from '../dist/i18n/ru.js';
import { strings } from '../dist/i18n/index.js';

/**
 * The report is the deliverable, and in the market where ГОСТ Р 52872-2019 is written
 * into a procurement contract it is handed to somebody who may not read English.
 *
 * A half-translated report is worse than an English one: it reads as unfinished work.
 * So the invariant is coverage — every rule, every string the report writes about
 * itself — checked here rather than by looking at one generated file and calling it done.
 */

const summaryOf = (file, source) => {
  const result = analyseSource(file, source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: null,
  });
  return {
    version: '0.1.0',
    totals: {
      violations: result.violations.length,
      errors: result.violations.filter((v) => v.severity === 'error').length,
      warnings: result.violations.filter((v) => v.severity === 'warning').length,
      info: result.violations.filter((v) => v.severity === 'info').length,
      automatic: 0,
      review: 0,
      manual: 0,
      fixed: 0,
    },
    byRule: [],
    suppressed: 0,
    files: [{ file, kind: 'html', violations: result.violations, suppressed: 0, unusedSuppressions: [], appliedFixes: 0, skippedFixes: 0 }],
  };
};

const render = (summary, lang) =>
  renderReport(summary, {
    subject: 'demo',
    generatedAt: '2026-08-31T00:00:00.000Z',
    level: 'AA',
    toolVersion: '0.1.0',
    includeInfo: true,
    lang,
  });

test('every rule has Russian text', () => {
  const missing = ALL_RULES.filter((r) => RULE_TEXT_RU[r.id] === undefined).map((r) => r.id);
  assert.deepEqual(missing, [], 'rules with no Russian text');
});

test('no Russian text is left as a stub or a copy of the English', () => {
  for (const rule of ALL_RULES) {
    const t = RULE_TEXT_RU[rule.id];
    assert.ok(t.title.length > 0, `${rule.id}: empty title`);
    assert.ok(t.summary.length > 0, `${rule.id}: empty summary`);
    assert.ok(t.impact.length > 0, `${rule.id}: empty impact`);
    assert.ok(t.manual.length > 0, `${rule.id}: empty manual remedy`);
    // Cyrillic somewhere in every field, so an untranslated placeholder cannot pass.
    // `manualByReason` holds one whole sentence per reason a rule can decline to patch,
    // and each of those is client-facing text in its own right, so it is walked into
    // rather than skipped.
    for (const [field, value] of Object.entries(t)) {
      if (typeof value === 'string') {
        assert.match(value, /[а-яА-ЯёЁ]/, `${rule.id}.${field} has no Russian in it: ${value}`);
        continue;
      }
      for (const [reason, sentence] of Object.entries(value)) {
        assert.match(
          sentence,
          /[а-яА-ЯёЁ]/,
          `${rule.id}.${field}.${reason} has no Russian in it: ${sentence}`,
        );
      }
    }
  }
});

test('both languages fill in the same set of strings', () => {
  const en = strings('en').ui;
  const ru = strings('ru').ui;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  for (const key of Object.keys(en)) {
    assert.equal(typeof en[key], typeof ru[key], `${key} differs in kind between languages`);
  }
});

test('a Russian report says nothing in English', () => {
  const source =
    `<!DOCTYPE html><html><head></head><body>` +
    `<img src="a.png"><a href="/x"><span></span></a><input type="text">` +
    `<p style="color:#aaaaaa;background:#ffffff;font-size:14px">низкий контраст</p>` +
    `<iframe src="/e"></iframe><div onclick="go()">клик</div>` +
    `</body></html>`;
  const html = render(summaryOf('page.html', source), 'ru');

  assert.match(html, /<html lang="ru"/);

  // Everything the report writes about itself, as opposed to what it quotes from the
  // scanned file. The prose lives between tags; code and criterion names do not.
  // The lookahead matters: without it `<p` also matches the `<pre>` that holds the
  // quoted source, and the test then demands a Russian translation of somebody's HTML.
  const prose = [...html.matchAll(/<(?:h1|h2|p|div|span|th|td)(?=[\s>])[^>]*>([^<]+)</g)]
    .map((m) => m[1].trim())
    .filter((s) => s.length > 12);
  assert.ok(prose.length > 10, 'the report got smaller than this test assumes');

  for (const line of prose) {
    // Identifiers and standard names are the same in every language: a W3C criterion
    // name, a rule id, the name of the standard, the name of the tool.
    if (/^\d\.\d\.\d /.test(line)) continue;
    if (/^A11Y-[A-Z]+-\d{3}/.test(line)) continue;
    assert.match(line, /[а-яА-ЯёЁ]/, `untranslated line in the Russian report: ${line}`);
  }
});

test('an English report is unchanged by the language machinery', () => {
  const source = `<!DOCTYPE html><html><head></head><body><img src="a.png"></body></html>`;
  const html = render(summaryOf('page.html', source), 'en');
  assert.match(html, /<html lang="en"/);
  assert.match(html, /Accessibility audit/);
  assert.match(html, /What this report is/);
  assert.match(html, /Image has no alt attribute/);
  // The English report keeps the per-finding detail it composes from the violation.
  assert.match(html, /a\.png/);
});

test('Russian counts decline', () => {
  const cases = [
    [1, '1 находка'],
    [2, '2 находки'],
    [4, '4 находки'],
    [5, '5 находок'],
    [11, '11 находок'],
    [12, '12 находок'],
    [14, '14 находок'],
    [21, '21 находка'],
    [22, '22 находки'],
    [25, '25 находок'],
    [101, '101 находка'],
    [111, '111 находок'],
  ];
  for (const [n, expected] of cases) {
    assert.equal(pluralRu(n, 'находка', 'находки', 'находок'), expected);
  }
});

test('the Russian report keeps the patch itself, which needs no translation', () => {
  // "text-gray-400 → text-gray-600" is the line a reader checks against their own file.
  // Dropping it in translation would remove the most persuasive thing in the document.
  const source =
    `<div className="bg-white"><p className="text-gray-400" style="font-size:16px">Текст</p></div>`;
  const html = render(summaryOf('Card.tsx', source), 'ru');
  assert.match(html, /Замена: text-gray-400 → text-gray-\d{3}/);
});

test('the "why it matters" sentence is not printed eight times', () => {
  // English composes it per finding and names the file in it, so it belongs with each
  // occurrence. Russian has one sentence per rule; repeating it under every instance of
  // the same rule reads as padding, which is what a deliverable cannot afford to.
  const source =
    `<!DOCTYPE html><html lang="ru"><head><title>t</title></head><body><main><h1>h</h1>` +
    Array.from({ length: 5 }, (_, i) => `<img src="a${i}.png">`).join('') +
    `</main></body></html>`;
  const summary = summaryOf('page.html', source);

  const ru = render(summary, 'ru');
  const impactRu = RULE_TEXT_RU['A11Y-IMG-001'].impact.slice(0, 40);
  assert.equal(ru.split(impactRu).length - 1, 1, 'the Russian impact is repeated per finding');

  const en = render(summary, 'en');
  assert.equal(en.split('a0.png').length - 1 >= 1, true);
  // English names a different file in each one, so all five are there and all differ.
  const impacts = [...en.matchAll(/<p class="impact">([^<]+)</g)].map((m) => m[1]);
  assert.equal(impacts.length, 5, `expected one impact per finding, got ${impacts.length}`);
});

test('Russian counts land in the right case', () => {
  const one = render(summaryOf('page.html', '<!DOCTYPE html><html><head></head><body><img src="a.png"></body></html>'), 'ru');
  assert.match(one, /проверено: 1 файл /, 'the subline should read "1 файл", not "1 файлов"');
  assert.match(one, / в 1 файле\./, '"в" takes the prepositional case');
});

/**
 * A Russian remedy must not assert a reason the tool's own analysis contradicts.
 *
 * The Russian report writes one hand-written sentence per rule, which is right — assembled
 * prose reads as machine output. But contrast declines to patch for three different
 * reasons, and one sentence then states one of them about all of them. On the museum audit
 * that was 205 findings telling the client the minimal change was "large enough to alter
 * the design" when the tool had computed the opposite: an imperceptible blue shift it
 * could not write because the colour is not in a rewritable form.
 */

const remedyFor = (css, body) => {
  const source = `<!DOCTYPE html><html lang="ru"><head><title>т</title></head><body><main><h1>з</h1>${body}</main></body></html>`;
  const { violations } = analyseSource('page.html', source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: null,
    stylesheets: [{ file: 's.css', content: css }],
  });
  const v = violations.find((x) => x.ruleId === 'A11Y-COLOR-001');
  assert.ok(v !== undefined, 'expected a contrast finding to talk about');
  return { v, ru: strings('ru').remedy(v), en: strings('en').remedy(v) };
};

test('a colour that cannot be rewritten in place does not blame the design', () => {
  // The colour arrives through a custom property, so there is no literal to edit — the
  // change itself would be tiny.
  const css = `:root { --brand: #0d6efd; }
               .b { background: #f0f0f0; }
               .b p { color: var(--brand); font-size: 16px; }`;
  const { v, ru } = remedyFor(css, '<div class="b"><p>Т</p></div>');
  if (v.fix?.safety !== 'manual') return; // resolved to a literal; nothing to assert
  assert.equal(v.fix.reason, 'not-rewritable');
  assert.ok(
    !/поменять оформление/.test(ru.text),
    `the remedy must not claim a design change: ${ru.text}`,
  );
  assert.match(ru.text, /не может переписать его на месте/);
});

test('a genuinely disruptive change still says so', () => {
  const css = `.b { background: #ff0000; } .b p { color: #ff5050; font-size: 16px; }`;
  const { v, ru } = remedyFor(css, '<div class="b"><p>Т</p></div>');
  if (v.fix?.reason !== 'design-change') return;
  assert.match(ru.text, /поменять оформление/);
});

test('every manual reason a rule can emit has a Russian sentence of its own', () => {
  // The guard that keeps this from rotting: a new reason code with no Russian text falls
  // back to the generic sentence, which is the failure this test exists to catch.
  const REASONS = ['design-change', 'not-rewritable', 'no-lightness-fix'];
  const text = RULE_TEXT_RU['A11Y-COLOR-001'];
  for (const reason of REASONS) {
    assert.ok(
      text.manualByReason?.[reason] !== undefined,
      `A11Y-COLOR-001 has no Russian sentence for reason "${reason}"`,
    );
  }
  const said = new Set(Object.values(text.manualByReason ?? {}));
  assert.equal(said.size, REASONS.length, 'each reason needs its own sentence, not a shared one');
});
