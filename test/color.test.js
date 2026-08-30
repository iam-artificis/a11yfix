import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contrastRatio,
  flatten,
  parseColor,
  repairContrast,
  repairPair,
  requiredRatio,
  rgbToOklch,
  oklchToRgb,
  toHex,
} from '../dist/color.js';

const P = (s) => {
  const c = parseColor(s);
  assert.ok(c !== null, `failed to parse ${s}`);
  return c;
};

test('contrast ratios match the WCAG reference values', () => {
  const cases = [
    ['#000000', '#ffffff', 21],
    ['#777777', '#ffffff', 4.478],
    ['#767676', '#ffffff', 4.542],
    ['#0000ff', '#ffffff', 8.592],
    ['#ff0000', '#ffffff', 3.998],
    ['#ffffff', '#ffffff', 1],
  ];
  for (const [a, b, expected] of cases) {
    const got = contrastRatio(P(a), P(b));
    assert.ok(
      Math.abs(got - expected) < 0.01,
      `${a} on ${b}: expected ~${expected}, got ${got.toFixed(3)}`,
    );
  }
});

test('contrast is symmetric', () => {
  assert.equal(contrastRatio(P('#123456'), P('#abcdef')), contrastRatio(P('#abcdef'), P('#123456')));
});

test('parses every colour syntax that appears in stylesheets', () => {
  assert.equal(toHex(P('#abc')), '#aabbcc');
  assert.equal(toHex(P('#aabbccdd')), '#aabbccdd');
  assert.equal(toHex(P('rgb(17, 34, 51)')), '#112233');
  assert.equal(toHex(P('rgba(17,34,51,0.5)')), '#11223380');
  assert.equal(toHex(P('hsl(210, 50%, 40%)')), '#336699');
  assert.equal(toHex(P('rgb(50% 20% 10% / 0.8)')), '#80331acc');
  assert.equal(toHex(P('rebeccapurple')), '#663399');
  assert.equal(toHex(P('WHITE')), '#ffffff');
  assert.equal(parseColor('not-a-colour'), null);
  assert.equal(parseColor(''), null);
  assert.equal(parseColor('#12345'), null);
});

test('OKLCH conversion round-trips exactly for sRGB colours', () => {
  for (const hex of ['#3b82f6', '#ef4444', '#10b981', '#777777', '#000000', '#ffffff', '#f59e0b']) {
    const rgb = P(hex);
    const back = oklchToRgb(rgbToOklch(rgb));
    assert.equal(toHex(back), hex, `${hex} did not round-trip`);
  }
});

test('achromatic colours report no hue rather than numerical noise', () => {
  const grey = rgbToOklch(P('#777777'));
  assert.equal(grey.c, 0);
  assert.equal(grey.h, 0);
});

test('required ratio follows the large-text rule', () => {
  assert.equal(requiredRatio({ level: 'AA', fontSizePx: 16, bold: false }), 4.5);
  assert.equal(requiredRatio({ level: 'AA', fontSizePx: 24, bold: false }), 3);
  assert.equal(requiredRatio({ level: 'AA', fontSizePx: 19, bold: true }), 3);
  assert.equal(requiredRatio({ level: 'AA', fontSizePx: 18, bold: true }), 4.5);
  assert.equal(requiredRatio({ level: 'AAA', fontSizePx: 16, bold: false }), 7);
  assert.equal(requiredRatio({ level: 'AA', fontSizePx: 12, bold: false, nonText: true }), 3);
});

test('repair reaches the target ratio and never returns something that still fails', () => {
  const pairs = [
    ['#777777', '#ffffff', 4.5],
    ['#3b82f6', '#ffffff', 4.5],
    ['#10b981', '#ffffff', 4.5],
    ['#999999', '#ffffff', 3],
    ['#94a3b8', '#f8fafc', 4.5],
    ['#ffffff', '#22c55e', 4.5],
  ];
  for (const [fg, bg, target] of pairs) {
    const fix = repairPair(P(fg), P(bg), target);
    assert.ok(fix !== null, `${fg} on ${bg}: expected a repair`);
    assert.ok(
      fix.ratio >= target - 1e-9,
      `${fg} on ${bg}: repair reached only ${fix.ratio.toFixed(3)}, needed ${target}`,
    );
  }
});

test('repair preserves hue for saturated colours', () => {
  for (const [fg, bg] of [['#3b82f6', '#ffffff'], ['#10b981', '#ffffff'], ['#ef4444', '#ffffff']]) {
    const fix = repairContrast(P(fg), P(bg), 4.5, { prefer: 'foreground' });
    assert.ok(fix !== null);
    const before = rgbToOklch(P(fg)).h;
    const after = rgbToOklch(fix.color).h;
    const drift = Math.min(Math.abs(before - after), 360 - Math.abs(before - after));
    assert.ok(drift < 1.5, `${fg}: hue drifted ${drift.toFixed(2)} degrees`);
  }
});

test('repair returns null when the pair already passes', () => {
  assert.equal(repairPair(P('#000000'), P('#ffffff'), 4.5), null);
  assert.equal(repairPair(P('#767676'), P('#ffffff'), 4.5), null);
});

test('repair moves the background when that is the smaller change', () => {
  // White label on a light amber button: darkening the text to pass would destroy the
  // button, so the background must be the side that moves.
  const fix = repairPair(P('#ffffff'), P('#f59e0b'), 4.5);
  assert.ok(fix !== null);
  assert.equal(fix.moved, 'background');
});

test('a repair large enough to change the design is flagged rather than applied', () => {
  const fix = repairPair(P('#e5e7eb'), P('#ffffff'), 4.5);
  assert.ok(fix !== null);
  assert.equal(fix.disruptive, true, 'near-white on white should not be silently patched');
});

test('alpha is composited against the backdrop before the ratio is taken', () => {
  const flat = flatten(P('rgba(0,0,0,0.5)'), P('#ffffff'));
  assert.equal(toHex(flat), '#808080');
});

test('repair output always lies inside the sRGB gamut', () => {
  for (const [fg, bg] of [['#00ff00', '#ffffff'], ['#ff00ff', '#ffffff'], ['#ffff00', '#ffffff']]) {
    const fix = repairPair(P(fg), P(bg), 4.5);
    if (fix === null) continue;
    for (const ch of ['r', 'g', 'b']) {
      assert.ok(fix.color[ch] >= 0 && fix.color[ch] <= 255, `${fg}: ${ch} out of gamut`);
      assert.equal(fix.color[ch], Math.round(fix.color[ch]), `${fg}: ${ch} not an integer`);
    }
  }
});
