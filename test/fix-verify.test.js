import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSource } from '../dist/engine.js';
import { ALL_RULES } from '../dist/rules/index.js';
import { contrastRatio, flatten, parseColor, repairContrast, requiredRatio } from '../dist/color.js';

/**
 * One invariant: a colour fix, once written, reaches the ratio the tool claimed for it.
 *
 * This is not a detail. The solver worked on flattened, opaque colours and then handed
 * back the replacement with the *source* alpha glued on — a colour it had never
 * measured. Written to the file it composited over the backdrop a second time, so
 * `rgba(0,0,0,0.5)` at 3.98:1 was "fixed" to `#76767680` at 1.94:1: the tool roughly
 * doubled the severity of the defect and reported it handled. Every translucent text
 * colour in a scanned tree was affected.
 *
 * The defence is to measure the patched source rather than to trust the solver, which is
 * what these tests do.
 */

const analyse = (file, source, opts = {}) =>
  analyseSource(file, source, {
    rules: ALL_RULES,
    level: 'AA',
    fixThreshold: 'review',
    ...opts,
  });

const page = (style, text = 'Terms and conditions apply.') =>
  `<html lang="en"><head><title>T</title></head><body style="background:#ffffff"><main><h1>Hi</h1>` +
  `<p style="${style}">${text}</p></main></body></html>`;

/** Contrast of the <p> in a patched document, read back out of the source. */
function measure(source) {
  const style = /<p style="([^"]*)"/.exec(source);
  assert.ok(style, 'the paragraph lost its style attribute');
  const colour = /color:\s*([^;"]+)/.exec(style[1]);
  assert.ok(colour, 'the paragraph lost its colour');
  const fg = parseColor(colour[1].trim());
  assert.ok(fg !== null, `unparseable colour written to source: ${colour[1]}`);
  const white = { r: 255, g: 255, b: 255, a: 1 };
  return contrastRatio(flatten(fg, white), white);
}

test('a translucent colour is repaired to something that actually passes', () => {
  const source = page('font-size:16px; color: rgba(0,0,0,0.5)');
  const before = measure(source);
  assert.ok(before < 4.5, `fixture should fail, measured ${before.toFixed(2)}`);

  const result = analyse('index.html', source);
  const fixed = result.fixedSource;
  assert.ok(fixed !== undefined && fixed !== source, 'no fix was applied');

  const after = measure(fixed);
  assert.ok(after >= 4.5, `patched source measures ${after.toFixed(2)}:1, still failing`);
  assert.ok(after > before, 'the patch must not make contrast worse');
});

test('the quoted ratio is the ratio the patched source has', () => {
  const source = page('font-size:16px; color: rgba(0,0,0,0.5)');
  const result = analyse('index.html', source);
  const v = result.violations.find((x) => x.ruleId === 'A11Y-COLOR-001');
  assert.ok(v?.fix !== undefined, 'no contrast fix offered');

  const claimed = /reaching ([\d.]+):1/.exec(v.fix.description);
  assert.ok(claimed, `description does not quote a ratio: ${v.fix.description}`);

  const actual = measure(result.fixedSource);
  assert.ok(
    Math.abs(Number(claimed[1]) - actual) < 0.05,
    `description claims ${claimed[1]}:1 but the file measures ${actual.toFixed(2)}:1`,
  );
});

test('no translucent input produces a fix that lowers contrast', () => {
  // A sweep rather than one case: the bug was in the shared solver, so it applied to
  // every alpha and every hue.
  for (const colour of [
    'rgba(0,0,0,0.5)',
    'rgba(0,0,0,0.3)',
    'rgba(20,40,120,0.6)',
    '#00000080',
    '#123456aa',
    'rgba(255,255,255,0.7)',
  ]) {
    const source = page(`font-size:16px; color: ${colour}`);
    const result = analyse('index.html', source);
    if (result.fixedSource === undefined || result.fixedSource === source) continue;
    const before = measure(source);
    const after = measure(result.fixedSource);
    assert.ok(
      after >= before,
      `${colour}: contrast fell from ${before.toFixed(2)}:1 to ${after.toFixed(2)}:1`,
    );
    assert.ok(after >= 4.5, `${colour}: patched to ${after.toFixed(2)}:1, still below AA`);
  }
});

test('every colour the tool names reaches the target, patched or merely advised', () => {
  // The solver froze one side of the pair while moving the other. That is right when the
  // foreground is opaque and wrong the moment it is not: a translucent foreground
  // re-composites over the *new* background, so the ratio the solver proved is not the
  // one the browser renders. It reported "change the background to #323232, reaching
  // 4.50:1" for a pair that renders at 3.43:1 and still fails.
  //
  // The advisory matters as much as the edit. When the change is too large to patch the
  // tool still names a colour, and a human will paste it in — so it has to be right for
  // the same reason.
  const ratio = (fg, bg) => {
    const opaque = { ...bg, a: 1 };
    return contrastRatio(flatten(fg, opaque), opaque);
  };

  const pairs = [
    ['rgba(255,255,255,0.4)', '#555555'],
    ['rgba(255,255,255,0.6)', '#bbbbbb'],
    ['rgba(255,255,255,0.3)', '#777777'],
    ['rgba(0,0,0,0.4)', '#888888'],
    ['rgba(0,0,0,0.25)', '#cccccc'],
    ['#ffffff66', '#555555'],
    ['#00000055', '#999999'],
    ['rgba(30,30,120,0.5)', '#dddddd'],
    ['rgba(255,0,0,0.5)', '#333333'],
    ['rgba(200,200,255,0.35)', '#404040'],
  ];

  for (const [fgText, bgText] of pairs) {
    const source =
      `<html lang="en"><head><title>t</title></head><body><main><h1>h</h1>` +
      `<p style="background-color: ${bgText}; color: ${fgText}; font-size: 16px">Read me</p>` +
      `</main></body></html>`;

    const v = analyse('p.html', source).violations.find((x) => x.ruleId === 'A11Y-COLOR-001');
    assert.ok(v !== undefined, `${fgText} on ${bgText} should fail AA`);

    const text = `${v.fix?.advisory ?? ''} ${v.fix?.description ?? ''}`;
    const named =
      /moves the (foreground|background) to (#[0-9a-f]{6})/i.exec(text) ??
      /Change the (foreground|background) from \S+ to (#[0-9a-f]{6})/i.exec(text);
    assert.ok(named, `${fgText} on ${bgText}: no colour named in "${text.trim()}"`);

    const fg = parseColor(fgText);
    const bg = parseColor(bgText);
    const proposed = parseColor(named[2]);
    const achieved =
      named[1].toLowerCase() === 'foreground' ? ratio(proposed, bg) : ratio(fg, proposed);

    assert.ok(
      achieved >= 4.5 - 0.01,
      `${fgText} on ${bgText}: named ${named[1]} ${named[2]}, which measures ${achieved.toFixed(2)}:1`,
    );
  }
});

test('repairContrast returns the colour it verified, not one wearing its alpha', () => {
  const translucent = { r: 0, g: 0, b: 0, a: 0.5 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const repair = repairContrast(translucent, white, requiredRatio({ level: 'AA', fontSizePx: 16 }));
  assert.ok(repair !== null, 'black at 50% over white should be repairable');

  assert.equal(repair.color.a, 1, 'the returned colour must be the opaque one that was solved');
  const measured = contrastRatio(flatten(repair.color, white), white);
  assert.ok(
    Math.abs(measured - repair.ratio) < 0.01,
    `reported ${repair.ratio.toFixed(2)}:1 but the colour measures ${measured.toFixed(2)}:1`,
  );
});

/**
 * A Tailwind background swap keeps the opacity modifier it found, so the replacement is
 * translucent even when the colour the solver proved was opaque. Verifying it needs two
 * things the first version got wrong: the candidate composites over the *backdrop*, not
 * over the text sitting on it, and the text then re-composites over the result.
 *
 * A sweep over the ramps found 72 pairs where the tool named a shade, quoted a ratio, and
 * the patched file measured below AA — the exact failure this file exists to prevent,
 * arriving through the Tailwind path instead of the CSS one.
 */

const tw = (classes) =>
  `<html lang="en"><head><title>t</title></head><body>` +
  `<div class="bg-white"><p style="font-size:16px" class="${classes}">Warning message here</p></div>` +
  `</body></html>`;

const contrastIn = (source) =>
  analyse('p.html', source).violations.filter((v) => v.ruleId === 'A11Y-COLOR-001');

test('a translucent background is verified against the backdrop, not against the text', () => {
  const source = tw('bg-red-600/60 text-yellow-100');
  const [v] = contrastIn(source);
  assert.ok(v !== undefined, 'red-600 at 60% over white should fail AA under pale yellow');
  if (v.fix?.edits?.length) {
    // The old answer was bg-red-950/60 "reaching 4.50:1", which renders at 4.32:1: the
    // candidate had been blended with the yellow text instead of with the white div.
    const patched = analyse('p.html', source).fixedSource;
    assert.deepEqual(
      contrastIn(patched),
      [],
      `patched to "${v.fix.description}" and it still fails`,
    );
  }
});

test('no Tailwind shade swap leaves the text below AA', () => {
  const families = ['red', 'blue', 'green', 'gray', 'slate', 'yellow', 'purple', 'orange'];
  const broken = [];
  for (const bgFamily of families) {
    for (const bgShade of [500, 600, 700, 800, 900]) {
      for (const alpha of ['', '/60', '/80']) {
        for (const textFamily of families) {
          for (const textShade of [100, 300, 500]) {
            const classes = `bg-${bgFamily}-${bgShade}${alpha} text-${textFamily}-${textShade}`;
            const source = tw(classes);
            const [v] = contrastIn(source);
            if (v?.fix?.edits?.length === undefined || v.fix.edits.length === 0) continue;
            const patched = analyse('p.html', source).fixedSource;
            if (contrastIn(patched).length > 0) broken.push(`${classes}: ${v.fix.description}`);
          }
        }
      }
    }
  }
  assert.deepEqual(broken.slice(0, 5), [], `${broken.length} swaps did not reach the ratio quoted`);
});

test('compositing lands on a colour that exists', () => {
  // The checker measures the palette's hex; the fix verifier composited in floating
  // point. Four ramp swaps were offered at "4.50:1" and measured at 4.49:1 afterwards —
  // a fix that does not fix, from nothing but a rounding difference between the halves.
  const mixed = flatten({ r: 30, g: 64, b: 175, a: 0.8 }, { r: 255, g: 255, b: 255, a: 1 });
  for (const channel of ['r', 'g', 'b']) {
    assert.equal(
      mixed[channel],
      Math.round(mixed[channel]),
      `${channel} came back as ${mixed[channel]}, which no screen can show`,
    );
  }
});
