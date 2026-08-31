import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { renderReport } from '../dist/report.js';
import { CRITERIA } from '../dist/wcag.js';
import { GOST_CRITERIA, GOST_NAME, gost, gostSection } from '../dist/gost.js';
import { strings } from '../dist/i18n/index.js';

/**
 * ГОСТ Р 52872-2019 is the reason the Russian report exists: the buyer is holding a
 * contract that names the standard, not WCAG. The mapping is an identity — the standard
 * was written from WCAG 2.1 and kept its numbering — which means the risk here is not a
 * wrong correspondence but a *claimed* one that is no longer true.
 *
 * The report says, in Russian, "все критерии, которые проверяет этот инструмент, в
 * стандарте есть". That sentence is checked here rather than believed, because the day
 * a rule cites a WCAG 2.2 addition it stops being true and nothing else would notice.
 */

test('every criterion any rule cites is in the standard', () => {
  const missing = [];
  for (const rule of ALL_RULES) {
    for (const sc of rule.wcag) {
      if (gost(sc) === undefined) missing.push(`${rule.id} cites ${sc}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'the Russian report claims every criterion checked is in the ГОСТ; these are not, ' +
      'so either the claim or the citation has to change',
  );
});

test('the standard and WCAG agree on the level of every criterion in both', () => {
  const cyrillic = (s) => s.replace(/A/g, 'А');
  const disagreements = [];
  for (const c of CRITERIA) {
    const g = gost(c.sc);
    if (g === undefined) continue;
    if (g.level !== cyrillic(c.level)) {
      disagreements.push(`${c.sc}: WCAG ${c.level}, ГОСТ ${g.level}`);
    }
  }
  assert.deepEqual(disagreements, []);
});

test('WCAG 2.2 additions are absent rather than guessed at', () => {
  // The standard predates WCAG 2.2. Inventing a clause number for a criterion that is
  // not in it would be the exact failure this tool is written against.
  for (const sc of ['2.4.11', '2.4.12', '2.4.13', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8']) {
    assert.equal(gost(sc), undefined, `${sc} should not be in the standard`);
    assert.equal(gostSection(sc), undefined);
  }
});

test('the whole standard is transcribed, not just what is cited today', () => {
  // 78 success criteria: WCAG 2.1's full set across A, AA and AAA.
  assert.equal(Object.keys(GOST_CRITERIA).length, 78);
  assert.equal(gost('1.4.3').title, 'Контрастность (минимальные требования)');
  assert.equal(gost('1.4.3').level, 'АА');
  assert.equal(gost('2.4.4').title, 'Цель ссылки (в контексте)');
  assert.equal(gost('4.1.2').title, 'Название, роль, значение');
  // Cyrillic А (U+0410), as the standard prints it — not Latin A.
  assert.equal(gost('1.1.1').level.codePointAt(0), 0x410);
});

test('the section number is derived the way the standard numbers itself', () => {
  // Section 4 is the requirements; 4.1 Воспринимаемый контент, 4.1.4 «Положение 1.4:
  // Различимость», which is where criterion 1.4.3 sits.
  assert.equal(gostSection('1.4.3'), '4.1.4');
  assert.equal(gostSection('1.1.1'), '4.1.1');
  assert.equal(gostSection('2.4.1'), '4.2.4');
  assert.equal(gostSection('3.3.2'), '4.3.3');
  assert.equal(gostSection('4.1.2'), '4.4.1');
});

const report = (source, lang) => {
  const result = analyseSource('page.html', source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: null,
  });
  const summary = {
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
    files: [
      {
        file: 'page.html',
        kind: 'html',
        violations: result.violations,
        suppressed: 0,
        unusedSuppressions: [],
        appliedFixes: 0,
        skippedFixes: 0,
      },
    ],
  };
  return renderReport(summary, {
    subject: 'demo',
    generatedAt: '2026-08-31T00:00:00.000Z',
    level: 'AA',
    toolVersion: '0.1.0',
    includeInfo: true,
    lang,
  });
};

const PAGE =
  '<!DOCTYPE html><html lang="ru"><head><title>т</title></head><body><main><h1>з</h1>' +
  '<p style="color:#aaaaaa;background:#ffffff;font-size:16px">текст</p>' +
  '<img src="a.png"></main></body></html>';

test('the Russian report names criteria as the standard does', () => {
  const html = report(PAGE, 'ru');
  assert.match(html, /1\.4\.3 Контрастность \(минимальные требования\) \(п\. 4\.1\.4\)/);
  assert.match(html, /1\.1\.1 Нетекстовый контент \(п\. 4\.1\.1\)/);
  assert.ok(html.includes(GOST_NAME), 'the report should name the standard it cites');
  // The level column is Cyrillic, so a reader can paste it into a Russian document.
  assert.match(html, /<td>АА<\/td>/);
  assert.doesNotMatch(html, /Contrast \(Minimum\)/);
});

test('the English report is untouched by any of this', () => {
  const html = report(PAGE, 'en');
  assert.match(html, /1\.4\.3 Contrast \(Minimum\)/);
  assert.match(html, /<td>AA<\/td>/);
  assert.ok(!html.includes(GOST_NAME), 'the English report should not cite a Russian standard');
  assert.ok(!html.includes('Контрастность'));
});

test('a criterion with no entry falls back to English rather than to nothing', () => {
  const ru = strings('ru').ui;
  assert.equal(ru.criterionName('2.4.11', 'Focus Not Obscured'), '2.4.11 Focus Not Obscured');
  assert.equal(ru.criterionName('1.4.3', 'Contrast (Minimum)'), '1.4.3 Контрастность (минимальные требования) (п. 4.1.4)');
});
