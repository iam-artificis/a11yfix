/**
 * Colour maths for contrast repair.
 *
 * Low-contrast text is the single most common accessibility failure on the web —
 * WebAIM's 2026 survey of the top million home pages found it on more than 83% of
 * them. It is also the only common failure that can be repaired by computation
 * rather than by judgement, which is why this file is the core of the tool.
 *
 * The repair strategy matters. Nudging an sRGB channel until the ratio passes
 * produces colours that drift in hue and look wrong to the designer who chose them,
 * and designers then revert the fix. So we work in OKLCH: hold hue fixed, move
 * lightness by the smallest amount that reaches the target ratio, and only reduce
 * chroma when the result would leave the sRGB gamut. The output is the nearest
 * passing colour a designer would have picked themselves.
 */

export interface RGB {
  /** 0-255 */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0-1. Alpha is tracked because contrast against a known backdrop needs it. */
  readonly a: number;
}

export interface OKLCH {
  /** Perceptual lightness, 0-1. */
  readonly l: number;
  /** Chroma, 0-~0.4 in sRGB. */
  readonly c: number;
  /** Hue in degrees, 0-360. */
  readonly h: number;
  readonly a: number;
}

/**
 * The full CSS named-colour set. Stylesheets in the wild use the obscure end of this
 * list often enough that a partial table silently skips real contrast failures — the
 * scanner would report "unsupported colour" and move on, which is the one failure
 * mode a checking tool must not have.
 */
const CSS_NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
  azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
  blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
  coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc',
  darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1',
  darkviolet: '#9400d3', deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969',
  dimgrey: '#696969', dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0',
  forestgreen: '#228b22', fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff',
  gold: '#ffd700', goldenrod: '#daa520', gray: '#808080', green: '#008000',
  greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4',
  indianred: '#cd5c5c', indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c',
  lavender: '#e6e6fa', lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd',
  lightblue: '#add8e6', lightcoral: '#f08080', lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3', lightgreen: '#90ee90',
  lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a', lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32',
  linen: '#faf0e6', magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db',
  mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc', mediumvioletred: '#c71585', midnightblue: '#191970',
  mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5', navajowhite: '#ffdead',
  navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23',
  orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa',
  palegreen: '#98fb98', paleturquoise: '#afeeee', palevioletred: '#db7093',
  papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb',
  plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
  red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513',
  salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee',
  sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd',
  slategray: '#708090', slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f',
  steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
  tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3',
  white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
  transparent: '#00000000',
};

/** Parse the colour syntaxes that actually appear in stylesheets. Returns null if unsupported. */
export function parseColor(input: string): RGB | null {
  const s = input.trim().toLowerCase();
  if (s === '') return null;

  const named = CSS_NAMED_COLORS[s];
  if (named !== undefined) return parseColor(named);

  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const expand = (ch: string): number => parseInt(ch + ch, 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0] as string),
        g: expand(hex[1] as string),
        b: expand(hex[2] as string),
        a: hex.length === 4 ? expand(hex[3] as string) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const byte = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
      if (!/^[0-9a-f]+$/.test(hex)) return null;
      return {
        r: byte(0),
        g: byte(2),
        b: byte(4),
        a: hex.length === 8 ? byte(6) / 255 : 1,
      };
    }
    return null;
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (fn !== null) {
    const kind = fn[1] as string;
    // Both comma and space syntax are legal; a slash separates alpha in space syntax.
    const parts = (fn[2] as string).replace(/\//g, ' ').split(/[\s,]+/).filter((p) => p !== '');
    if (parts.length < 3) return null;
    const num = (raw: string, scale: number): number => {
      const v = parseFloat(raw);
      if (Number.isNaN(v)) return NaN;
      return raw.endsWith('%') ? (v / 100) * scale : v;
    };
    const alpha = parts.length >= 4 ? clamp(num(parts[3] as string, 1), 0, 1) : 1;
    if (kind.startsWith('rgb')) {
      const r = num(parts[0] as string, 255);
      const g = num(parts[1] as string, 255);
      const b = num(parts[2] as string, 255);
      if ([r, g, b, alpha].some(Number.isNaN)) return null;
      return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: alpha };
    }
    const h = parseFloat(parts[0] as string);
    const sat = num(parts[1] as string, 1);
    const light = num(parts[2] as string, 1);
    if ([h, sat, light, alpha].some(Number.isNaN)) return null;
    return hslToRgb(h, clamp(sat, 0, 1), clamp(light, 0, 1), alpha);
  }

  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hslToRgb(h: number, s: number, l: number, a: number): RGB {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hh < 60) rgb = [c, x, 0];
  else if (hh < 120) rgb = [x, c, 0];
  else if (hh < 180) rgb = [0, c, x];
  else if (hh < 240) rgb = [0, x, c];
  else if (hh < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return {
    r: Math.round((rgb[0] + m) * 255),
    g: Math.round((rgb[1] + m) * 255),
    b: Math.round((rgb[2] + m) * 255),
    a,
  };
}

/** Format as the shortest exact hex, preserving alpha only when it is not opaque. */
export function toHex(c: RGB): string {
  const h = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  if (c.a >= 1) return base;
  return `${base}${h(c.a * 255)}`;
}

/** sRGB 0-255 channel to linear-light 0-1, per IEC 61966-2-1. */
function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const out = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return out * 255;
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(c: RGB): number {
  return (
    0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b)
  );
}

/**
 * Composite a possibly-translucent colour over an opaque backdrop.
 * Contrast is only meaningful between opaque colours, so any alpha must be resolved
 * against something before the ratio means anything.
 */
export function flatten(fg: RGB, backdrop: RGB): RGB {
  if (fg.a >= 1) return fg;
  const mix = (f: number, b: number): number => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, backdrop.r), g: mix(fg.g, backdrop.g), b: mix(fg.b, backdrop.b), a: 1 };
}

/** WCAG 2.x contrast ratio, 1-21. Inputs must already be opaque. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Required ratio for a given text size, per WCAG 1.4.3 (AA) and 1.4.6 (AAA). */
export function requiredRatio(opts: {
  readonly level: 'AA' | 'AAA';
  /** CSS px. */
  readonly fontSizePx: number;
  readonly bold: boolean;
  /** Icons, borders and other non-text visuals fall under 1.4.11 at a flat 3:1. */
  readonly nonText?: boolean;
}): number {
  if (opts.nonText === true) return 3;
  // "Large text" is 18pt (24px), or 14pt (18.66px) when bold.
  const large = opts.fontSizePx >= 24 || (opts.bold && opts.fontSizePx >= 18.66);
  if (opts.level === 'AAA') return large ? 4.5 : 7;
  return large ? 3 : 4.5;
}

// ---------------------------------------------------------------------------
// OKLab / OKLCH — Björn Ottosson's perceptual space, as adopted by CSS Color 4.
// ---------------------------------------------------------------------------

function rgbToOklab(c: RGB): { L: number; a: number; b: number } {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgbRaw(L: number, A: number, B: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/**
 * Below this chroma a colour is achromatic for practical purposes and its hue angle
 * is numerical noise — atan2 of two near-zero components. Reporting that noise as a
 * hue makes greys look like they are drifting in colour when nothing is happening.
 */
const ACHROMATIC_CHROMA = 0.002;

export function rgbToOklch(c: RGB): OKLCH {
  const { L, a, b } = rgbToOklab(c);
  const chroma = Math.sqrt(a * a + b * b);
  if (chroma < ACHROMATIC_CHROMA) return { l: L, c: 0, h: 0, a: c.a };
  let hue = (Math.atan2(b, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { l: L, c: chroma, h: hue, a: c.a };
}

/** True when the OKLCH triple lands inside sRGB without clipping. */
function inGamut(l: number, c: number, h: number): boolean {
  const rad = (h * Math.PI) / 180;
  const { r, g, b } = oklabToRgbRaw(l, c * Math.cos(rad), c * Math.sin(rad));
  const eps = 0.5; // half a channel step: rounding will absorb this
  return r >= -eps && r <= 255 + eps && g >= -eps && g <= 255 + eps && b >= -eps && b <= 255 + eps;
}

/**
 * Convert OKLCH back to sRGB, reducing chroma until the colour fits the gamut.
 *
 * Clipping channels instead would shift hue — the exact artefact that makes naive
 * contrast fixers produce colours designers reject. Binary search on chroma keeps
 * hue and lightness exact and gives up only saturation, which is the least
 * perceptually disruptive thing to trade away.
 */
export function oklchToRgb(col: OKLCH): RGB {
  let c = Math.max(0, col.c);
  const l = clamp(col.l, 0, 1);
  if (!inGamut(l, c, col.h)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(l, mid, col.h)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  const rad = (col.h * Math.PI) / 180;
  const raw = oklabToRgbRaw(l, c * Math.cos(rad), c * Math.sin(rad));
  return {
    r: Math.round(clamp(raw.r, 0, 255)),
    g: Math.round(clamp(raw.g, 0, 255)),
    b: Math.round(clamp(raw.b, 0, 255)),
    a: col.a,
  };
}

export interface ContrastRepair {
  /** The replacement colour. */
  readonly color: RGB;
  /** Which of the pair was moved. */
  readonly moved: 'foreground' | 'background';
  /** Ratio achieved by the replacement. */
  readonly ratio: number;
  /**
   * Perceptual distance from the original, in OKLCH lightness units (0-1).
   * Small numbers mean the fix is visually close to the designer's intent.
   */
  readonly deltaL: number;
}

/**
 * Find the smallest lightness change that reaches `target` contrast.
 *
 * Direction is chosen by which way the pair is already leaning: darken text that is
 * already darker than its background, lighten text that is already lighter. Reversing
 * the polarity of a design is never the minimal edit, even when it would technically
 * pass, so we only fall back to the other direction if the natural one cannot reach
 * the target before hitting black or white.
 */
export function repairContrast(
  foreground: RGB,
  background: RGB,
  target: number,
  options: { readonly prefer?: 'foreground' | 'background' } = {},
): ContrastRepair | null {
  const bgOpaque: RGB = { ...background, a: 1 };
  const which = options.prefer ?? 'foreground';
  const original = which === 'foreground' ? flatten(foreground, bgOpaque) : bgOpaque;
  const other = which === 'foreground' ? bgOpaque : flatten(foreground, bgOpaque);

  if (contrastRatio(original, other) >= target) return null;

  const start = rgbToOklch(original);
  const otherLum = relativeLuminance(other);
  const startLum = relativeLuminance(original);
  // Move away from the other colour: darker if we are already the darker one.
  const directions: (1 | -1)[] = startLum <= otherLum ? [-1, 1] : [1, -1];

  for (const dir of directions) {
    const limit = dir === 1 ? 1 : 0;
    // Does the extreme even reach the target? If not, this direction is hopeless.
    const extreme = oklchToRgb({ ...start, l: limit });
    if (contrastRatio(extreme, other) < target) continue;

    // Binary search the smallest |ΔL| that passes. Contrast is monotonic in lightness
    // once the direction is fixed, so bisection is exact to within the tolerance.
    let lo = start.l;
    let hi = limit;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      const candidate = oklchToRgb({ ...start, l: mid });
      if (contrastRatio(candidate, other) >= target) hi = mid;
      else lo = mid;
    }
    const fixed = oklchToRgb({ ...start, l: hi });
    const ratio = contrastRatio(fixed, other);
    // Guard against rounding leaving us a hair under the threshold.
    if (ratio < target) continue;
    return {
      // The solved colour is opaque, and it is the one whose ratio was just verified.
      // Putting the source alpha back would hand out a colour nobody measured: written
      // to the file it composites over the backdrop a second time, so the ratio the
      // solver proved is not the ratio the browser renders. rgba(0,0,0,0.5) at 3.98:1
      // came back as #76767680 at 1.94:1 — the tool making the defect twice as bad
      // while reporting it fixed.
      color: fixed,
      moved: which,
      ratio,
      deltaL: Math.abs(hi - start.l),
    };
  }
  return null;
}

/**
 * A fix that changes lightness by more than this is no longer a repair — it is a
 * redesign. #ffffff text on a light amber button, for example, only reaches 4.5:1
 * if the text goes near-black, which passes the checker and destroys the button.
 * Past this threshold the honest output is "a human needs to choose", not a patch.
 */
export const DISRUPTIVE_DELTA_L = 0.18;

export interface PairRepair extends ContrastRepair {
  /**
   * True when even the smallest passing change is large enough to alter the design's
   * intent. Callers should surface these as advice rather than writing them to disk.
   */
  readonly disruptive: boolean;
  /** The alternative that was considered and rejected, for reporting. */
  readonly alternative?: ContrastRepair;
}

/**
 * Repair a foreground/background pair by whichever side moves least.
 *
 * Fixing contrast by always darkening the text is what naive tools do, and it is
 * wrong roughly half the time: light text on a mid-tone button should be fixed by
 * darkening the button, not by turning the label grey. Trying both and preferring the
 * smaller perceptual move gets that right without needing to know which colour the
 * designer considers load-bearing.
 *
 * `lockBackground` exists because a background is often shared by many elements — a
 * page body, a card surface — so changing it to fix one label can break twenty others.
 * When the caller knows the background is shared, the foreground is the only safe side.
 */
export function repairPair(
  foreground: RGB,
  background: RGB,
  target: number,
  options: { readonly lockBackground?: boolean; readonly lockForeground?: boolean } = {},
): PairRepair | null {
  const bgOpaque: RGB = { ...background, a: 1 };
  if (contrastRatio(flatten(foreground, bgOpaque), bgOpaque) >= target) return null;

  const candidates: ContrastRepair[] = [];
  if (options.lockForeground !== true) {
    const f = repairContrast(foreground, background, target, { prefer: 'foreground' });
    if (f !== null) candidates.push(f);
  }
  if (options.lockBackground !== true) {
    const b = repairContrast(foreground, background, target, { prefer: 'background' });
    if (b !== null) candidates.push(b);
  }
  if (candidates.length === 0) return null;

  candidates.sort((x, y) => x.deltaL - y.deltaL);
  const best = candidates[0] as ContrastRepair;
  const alt = candidates[1];
  return {
    ...best,
    disruptive: best.deltaL > DISRUPTIVE_DELTA_L,
    ...(alt !== undefined ? { alternative: alt } : {}),
  };
}
