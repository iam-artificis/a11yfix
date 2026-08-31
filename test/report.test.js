import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { renderReport, escapeHtml } from '../dist/report.js';
import { countByFixClass, fixClass } from '../dist/fix/classify.js';
import { CRITERIA, criterion, criterionUrl } from '../dist/wcag.js';

/**
 * The report is the only output a non-developer will ever see, which makes two things
 * load-bearing: it must not overstate what the tool checked, and every number in it must
 * agree with every other number in it. A report whose summary and body disagree is worth
 * less than no report, because the reader stops believing the parts that are correct.
 */

const OPTIONS = {
  subject: 'example.com',
  generatedAt: '2026-01-15T09:30:00.000Z',
  level: 'AA',
  toolVersion: '9.9.9',
};

const DIRTY = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="background:#ffffff">
  <img src="hero.png">
  <p style="color:#9aa0a6">Low contrast body text.</p>
  <a href="/pricing">click here</a>
  <input type="text" name="email">
</body></html>`;

const CLEAN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pricing</title></head>
<body><main><h1>Pricing</h1><p>Plain text.</p></main></body></html>`;

const summaryFor = (file, source) => {
  const r = analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: null });
  const all = r.violations;
  const counts = countByFixClass(all);
  return {
    files: [r],
    totals: {
      violations: all.length,
      errors: all.filter((v) => v.severity === 'error').length,
      warnings: all.filter((v) => v.severity === 'warning').length,
      info: all.filter((v) => v.severity === 'info').length,
      ...counts,
      fixed: 0,
    },
    byRule: [],
    durationMs: 0,
  };
};

test('every part of the source that reaches the page is escaped', () => {
  const hostile = `<!doctype html>
<html lang="en"><head><title>t</title></head><body><main>
  <img src="&quot;><script>alert(1)</script>" title="'>">
</main></body></html>`;
  const html = renderReport(summaryFor('x.html', hostile), OPTIONS);

  // The report embeds somebody else's source verbatim. If any of it survives unescaped,
  // opening the report runs it.
  assert.ok(!html.includes('<script>alert(1)</script>'), 'a script tag survived into the report');
  assert.ok(html.includes('&lt;script&gt;'), 'the script tag should appear as escaped text');

  // Nothing but our own markup should introduce a tag. Strip our tags and no angle
  // bracket may remain.
  const body = html.slice(html.indexOf('<body'));
  const withoutTags = body.replace(/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/gi, '');
  assert.ok(!withoutTags.includes('<'), 'unescaped markup leaked into the report body');
});

test('escapeHtml covers every character that can break out of text or an attribute', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('the headline counts equal the findings the report actually lists', () => {
  const summary = summaryFor('page.html', DIRTY);
  const html = renderReport(summary, OPTIONS);

  const shown = summary.files[0].violations.filter((v) => v.severity !== 'info');
  const errors = shown.filter((v) => v.severity === 'error').length;
  const warnings = shown.filter((v) => v.severity === 'warning').length;
  const counts = countByFixClass(shown);

  const card = (label) => {
    const m = html.match(new RegExp(`<div class="n">(\\d+)</div><div class="l">${label}</div>`));
    assert.ok(m, `no card labelled ${label}`);
    return Number(m[1]);
  };

  assert.equal(card('Errors'), errors);
  assert.equal(card('Warnings'), warnings);
  assert.equal(card('Need a person'), counts.manual);
  assert.equal(card('Fixable by patch'), counts.automatic + counts.review);
  // The two halves must account for everything: a reader adding them up should get the total.
  assert.equal(card('Fixable by patch') + card('Need a person'), shown.length);
});

test('every finding is listed with its file and line, so each claim can be checked', () => {
  const summary = summaryFor('src/page.html', DIRTY);
  const html = renderReport(summary, OPTIONS);
  for (const v of summary.files[0].violations) {
    if (v.severity === 'info') continue;
    assert.ok(html.includes(`line ${v.line}`), `line ${v.line} missing for ${v.ruleId}`);
    assert.ok(html.includes(v.ruleId), `${v.ruleId} missing from the report`);
  }
  assert.ok(html.includes('src/page.html'), 'the file path should appear');
});

test('the limits are stated before the findings, not after', () => {
  const html = renderReport(summaryFor('page.html', DIRTY), OPTIONS);
  const caveat = html.indexOf('not a conformance statement');
  const findings = html.indexOf('<h2>Findings</h2>');
  assert.ok(caveat > 0, 'the report must say it is not a conformance statement');
  assert.ok(findings > 0, 'the report should have a findings section');
  assert.ok(caveat < findings, 'the caveat has to come first — burying it is the overlay lie');
});

test('a clean run does not turn into a conformance claim', () => {
  const summary = summaryFor('page.html', CLEAN);
  const html = renderReport(summary, OPTIONS);
  assert.ok(!/\bcompliant\b/i.test(html), 'the report must never call anything compliant');
  assert.ok(!/\bconformant\b/i.test(html));
  assert.ok(html.includes('not a conformance statement'));
  assert.ok(/narrow one/.test(html), 'a clean result should be qualified, not celebrated');
});

test('the report is self-contained: no external requests', () => {
  const html = renderReport(summaryFor('page.html', DIRTY), OPTIONS);
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!/<link\b/i.test(html), 'no stylesheets to fetch');
  assert.ok(!/<img\b/i.test(html), 'no images to fetch');
  // Only w3.org references, and only as links a reader may follow, never as loads.
  const urls = [...html.matchAll(/https?:\/\/[^"'\s<)]+/g)].map((m) => m[0]);
  for (const url of urls) {
    assert.match(url, /^https:\/\/www\.w3\.org\//, `unexpected external reference: ${url}`);
  }
});

test('rendering is deterministic', () => {
  const summary = summaryFor('page.html', DIRTY);
  assert.equal(renderReport(summary, OPTIONS), renderReport(summary, OPTIONS));
});

test('info findings are excluded unless asked for', () => {
  const summary = summaryFor('page.html', DIRTY);
  const info = summary.files[0].violations.filter((v) => v.severity === 'info');
  const plain = renderReport(summary, OPTIONS);
  const withInfo = renderReport(summary, { ...OPTIONS, includeInfo: true });
  if (info.length > 0) {
    assert.ok(plain.includes('not shown'), 'hidden info findings should be acknowledged');
    assert.ok(withInfo.length > plain.length);
  }
  assert.ok(!plain.includes('<span class="tag info">'), 'no info findings in the default report');
});

test('long runs of one finding are capped, and --all lifts the cap', () => {
  // Twenty of the same missing alt. Capped, the report has to say how many it left out;
  // uncapped, it has to list all of them, because somebody handed this as a deliverable
  // needs every occurrence rather than a sample.
  const rows = Array.from({ length: 20 }, (_, i) => `  <img src="img-${i}.png">`).join('\n');
  const source = `<!doctype html>
<html lang="en"><head><title>Gallery</title></head><body><main><h1>Gallery</h1>
${rows}
</main></body></html>`;

  const summary = summaryFor('gallery.html', source);
  const capped = renderReport(summary, OPTIONS);
  const full = renderReport(summary, { ...OPTIONS, includeInfo: true });

  const count = (html, needle) => html.split(needle).length - 1;

  assert.equal(count(capped, '<div class="instance">'), 12 + countNonImg(summary));
  assert.ok(capped.includes('8 further occurrences are not listed here'));
  assert.ok(capped.includes('--all'), 'the report must say how to see the rest');

  assert.ok(!full.includes('not listed here'), '--all must not truncate');
  assert.ok(full.includes('img-19.png'), 'the last occurrence should be listed');
});

/** Instances the gallery fixture produces outside the capped rule. */
function countNonImg(summary) {
  return summary.files[0].violations.filter(
    (v) => v.severity !== 'info' && v.ruleId !== 'A11Y-IMG-001',
  ).length;
}

test('every criterion a rule claims exists in the WCAG table', () => {
  // A rule citing a criterion the table does not know about would render as a bare number
  // with a link to the standard's front page — the kind of small wrongness a client
  // notices and a developer never does.
  for (const rule of ALL_RULES) {
    for (const sc of rule.wcag) {
      assert.ok(criterion(sc) !== undefined, `${rule.id} cites unknown criterion ${sc}`);
    }
  }
});

test('criterion links match the W3C paths, parentheticals included', () => {
  const cases = {
    '1.1.1': 'non-text-content',
    '1.2.3': 'audio-description-or-media-alternative-prerecorded',
    '1.4.3': 'contrast-minimum',
    '2.4.4': 'link-purpose-in-context',
    '2.4.9': 'link-purpose-link-only',
    '3.3.4': 'error-prevention-legal-financial-data',
    '4.1.2': 'name-role-value',
  };
  for (const [sc, slug] of Object.entries(cases)) {
    assert.equal(
      criterionUrl(sc),
      `https://www.w3.org/WAI/WCAG22/Understanding/${slug}`,
      `wrong URL for ${sc}`,
    );
  }

  // Two criteria must never share a page: that was the bug.
  const urls = CRITERIA.map((c) => criterionUrl(c.sc));
  assert.equal(new Set(urls).size, urls.length, 'two criteria resolved to the same URL');

  assert.equal(criterionUrl('9.9.9'), 'https://www.w3.org/TR/WCAG22/');
  assert.ok(CRITERIA.filter((c) => c.reach === 'partial').length > 0);
});

test('no rule cites a criterion WCAG 2.2 removed', () => {
  // 4.1.1 Parsing was made obsolete in 2.2 and always passes. Citing it in a client
  // report is a straightforward factual error about the standard.
  for (const rule of ALL_RULES) {
    assert.ok(!rule.wcag.includes('4.1.1'), `${rule.id} cites 4.1.1, removed in WCAG 2.2`);
  }
  assert.ok(!CRITERIA.some((c) => c.sc === '4.1.1'));
});

test('a fix the tool will never apply is not counted as fixable', () => {
  // fixAllowed refuses anything marked manual, anything carrying an advisory, and
  // anything with no edits. fixClass has to agree with it exactly, or the summary
  // promises work that --fix will not do.
  const base = {
    ruleId: 'A11Y-TEST-001',
    wcag: [],
    level: 'A',
    severity: 'error',
    file: 'x.html',
    start: 0,
    end: 1,
    line: 1,
    column: 1,
    message: 'm',
    impact: 'i',
    excerpt: 'e',
  };
  const edit = { start: 0, end: 1, replacement: 'x', label: 'l' };

  assert.equal(fixClass({ ...base }), 'manual', 'no fix at all');
  assert.equal(
    fixClass({ ...base, fix: { safety: 'automatic', edits: [], description: 'd' } }),
    'manual',
    'automatic but with nothing to write',
  );
  assert.equal(
    fixClass({ ...base, fix: { safety: 'review', edits: [edit], description: 'd', advisory: 'a' } }),
    'manual',
    'an advisory means a person decides',
  );
  assert.equal(
    fixClass({ ...base, fix: { safety: 'manual', edits: [edit], description: 'd' } }),
    'manual',
    'a manual fix is never written, whatever it carries',
  );
  assert.equal(
    fixClass({ ...base, fix: { safety: 'automatic', edits: [edit], description: 'd' } }),
    'automatic',
  );
  assert.equal(
    fixClass({ ...base, fix: { safety: 'review', edits: [edit], description: 'd' } }),
    'review',
  );
});


/**
 * The list of pages a site audit read.
 *
 * A whole-site audit that does not say which pages it read invites the reader to assume
 * it read all of them, and the reader is paying for the answer. The table is also the
 * only place an empty page can be told apart from a clean one: a shell assembled in the
 * browser arrives with nothing in it, and a zero next to it, unqualified, is the one
 * number in this report that would be a lie.
 */

const multi = (pages) => {
  const files = pages.map(([file, source]) =>
    analyseSource(file, source, { rules: ALL_RULES, level: 'AA', fixThreshold: null }),
  );
  const all = files.flatMap((f) => f.violations);
  const counts = countByFixClass(all);
  return {
    files,
    totals: {
      violations: all.length,
      errors: all.filter((v) => v.severity === 'error').length,
      warnings: all.filter((v) => v.severity === 'warning').length,
      info: all.filter((v) => v.severity === 'info').length,
      ...counts,
      fixed: 0,
    },
    byRule: [],
    durationMs: 0,
  };
};

const SHELL = `<!doctype html>
<html lang="en"><head><title>t</title></head><body><div id="root"></div></body></html>`;

const pageRows = (html) => {
  const table = html.slice(html.indexOf('Pages checked'));
  const body = table.slice(table.indexOf('<tbody>'), table.indexOf('</tbody>'));
  return body
    .split('<tr>')
    .slice(1)
    .map((row) => {
      const cells = row
        .split('</td>')
        .slice(0, 4)
        .map((cell) => cell.slice(cell.indexOf('>') + 1).trim());
      const [page, errors, warnings, total] = cells;
      return {
        // The sparse badge is markup inside the first cell; the URL is what precedes it.
        page: page.split('<')[0],
        badged: page.includes('<span'),
        errors: Number(errors),
        warnings: Number(warnings),
        total: Number(total),
      };
    });
};

test('every page read gets a row, including the ones with nothing wrong', () => {
  const summary = multi([
    ['example.ru/a.html', DIRTY],
    ['example.ru/b.html', CLEAN],
  ]);
  const html = renderReport(summary, {
    ...OPTIONS,
    fetched: [
      { url: 'https://example.ru/a', file: 'example.ru/a.html', sparse: false },
      { url: 'https://example.ru/b', file: 'example.ru/b.html', sparse: false },
    ],
  });
  const rows = pageRows(html);
  assert.deepEqual(
    rows.map((r) => r.page),
    ['https://example.ru/a', 'https://example.ru/b'],
    'a page with no findings is still evidence of what was covered',
  );
  assert.ok(rows[0].errors > 0);
  assert.equal(rows[1].total, 0);
});

test('the per-page counts add up to the headline counts', () => {
  const summary = multi([
    ['example.ru/a.html', DIRTY],
    ['example.ru/b.html', DIRTY],
    ['example.ru/c.html', CLEAN],
  ]);
  const html = renderReport(summary, {
    ...OPTIONS,
    fetched: ['a', 'b', 'c'].map((n) => ({
      url: `https://example.ru/${n}`,
      file: `example.ru/${n}.html`,
      sparse: false,
    })),
  });
  const rows = pageRows(html);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  assert.equal(sum('errors'), summary.totals.errors);
  assert.equal(sum('warnings'), summary.totals.warnings);
  assert.equal(sum('total'), summary.totals.violations);
});

test('the worst page is first, because the list is also the order of work', () => {
  const summary = multi([
    ['example.ru/quiet.html', CLEAN],
    ['example.ru/loud.html', DIRTY],
  ]);
  const html = renderReport(summary, {
    ...OPTIONS,
    fetched: [
      { url: 'https://example.ru/quiet', file: 'example.ru/quiet.html', sparse: false },
      { url: 'https://example.ru/loud', file: 'example.ru/loud.html', sparse: false },
    ],
  });
  assert.equal(pageRows(html)[0].page, 'https://example.ru/loud');
});

test('a page assembled in the browser is marked, so its zero is not read as clean', () => {
  const summary = multi([['example.ru/app.html', SHELL]]);
  const html = renderReport(summary, {
    ...OPTIONS,
    fetched: [{ url: 'https://example.ru/app', file: 'example.ru/app.html', sparse: true }],
  });
  assert.match(html, /arrived nearly empty/);
  const rows = pageRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].badged, true, 'the shell page carries the badge');
  // The count is not suppressed — it is qualified. Whatever number sits there describes
  // the shell the server sent, and the note under the table says so.
  assert.ok(rows[0].total >= 0);

  // And the caveat is absent when it does not apply, so it keeps its meaning.
  const solid = renderReport(multi([['example.ru/a.html', DIRTY]]), {
    ...OPTIONS,
    fetched: [{ url: 'https://example.ru/a', file: 'example.ru/a.html', sparse: false }],
  });
  assert.ok(!solid.includes('arrived nearly empty'));
});

test('the HTTP caveat states the count instead of listing every URL in one paragraph', () => {
  const summary = multi([['example.ru/a.html', DIRTY]]);
  const many = Array.from({ length: 40 }, (_, i) => ({
    url: `https://example.ru/p${i}`,
    file: `example.ru/p${i}.html`,
    sparse: false,
  }));
  const html = renderReport(summary, { ...OPTIONS, fetched: many });
  const note = html.slice(html.indexOf('<div class="note">'), html.indexOf('Pages checked'));
  assert.match(note, /40 pages, listed below|40 pages/);
  assert.ok(
    !note.includes('https://example.ru/p39'),
    'the caveat should not be a wall of forty URLs; the table below is where they belong',
  );
});

test('a scan with no fetched pages has no page table at all', () => {
  const html = renderReport(summaryFor('src/App.tsx', DIRTY), OPTIONS);
  assert.ok(!html.includes('Pages checked'));
});
