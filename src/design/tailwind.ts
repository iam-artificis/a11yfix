/**
 * Tailwind utility resolution.
 *
 * Tailwind is worth special-casing because in a Tailwind codebase the colours are in
 * the markup, not in a stylesheet — `class="text-gray-400 bg-white"` is the entire
 * declaration. A contrast checker that only reads CSS files sees nothing at all in
 * these projects, which is most new front-end work.
 *
 * The bundled palette is Tailwind's default. Projects that customise it can point the
 * tool at their own values, and Tailwind v4 projects declare theirs as CSS custom
 * properties which the stylesheet pass picks up directly — so this table is a fallback
 * for the common case, never an assumption we refuse to revise.
 */

export interface TailwindDecl {
  readonly color?: string;
  readonly background?: string;
  /**
   * The element paints a background that is not a single colour — a gradient, an image.
   * Distinct from "no background": here we know something is behind the text and we know
   * we cannot say what it is, so the ancestor walk must stop rather than skip past it.
   */
  readonly backgroundUnknown?: boolean;
  readonly borderColor?: string;
  readonly fontSizePx?: number;
  readonly bold?: boolean;
  /** Utility classes we recognised but could not resolve to a value. */
  readonly unresolved: readonly string[];
}

/** Tailwind's default colour palette (v3.4 / v4 default theme). */
export const TAILWIND_COLORS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
  gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
  zinc: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
  neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
  stone: { 50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' },
  red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
  orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
  amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
  yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
  lime: { 50: '#f7fee7', 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16', 600: '#65a30d', 700: '#4d7c0f', 800: '#3f6212', 900: '#365314', 950: '#1a2e05' },
  green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
  emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
  teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
  cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
  sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
  blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
  indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
  violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
  purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
  fuchsia: { 50: '#fdf4ff', 100: '#fae8ff', 200: '#f5d0fe', 300: '#f0abfc', 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 900: '#701a75', 950: '#4a044e' },
  pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
  rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' },
};

/** Standalone colour keywords that take no shade. */
const STANDALONE: Readonly<Record<string, string>> = {
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
  current: 'currentColor',
  inherit: 'inherit',
};

/** Tailwind's default type scale, in px. */
const TEXT_SIZES: Readonly<Record<string, number>> = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20,
  '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128,
};

const BOLD_WEIGHTS = new Set(['bold', 'extrabold', 'black', 'semibold']);

/** Prefixes that make a utility conditional, so it does not describe the default state. */
const CONDITIONAL = /^(hover|focus|focus-visible|focus-within|active|visited|disabled|group-hover|group-focus|peer-hover|peer-focus|dark|print|motion-safe|motion-reduce|first|last|odd|even|sm|md|lg|xl|2xl|max-sm|max-md|max-lg|max-xl|aria-|data-|has-|supports-|open|checked|required|invalid)/;

/**
 * Background utilities that paint something other than a flat colour.
 *
 * Text over one of these has a backdrop we cannot evaluate. Treating such an element as
 * having no background at all — which is what happens if these are simply unrecognised —
 * lets the walk continue to an ancestor's colour and produce a contrast number for a
 * pairing that never renders.
 */
const PAINTS_NON_COLOUR =
  /^bg-(?:gradient-to-|linear-|radial-|conic-|\[url\(|\[image:|none$|cover$|contain$|\[length:)/;

/** Resolve a Tailwind colour token such as "gray-400", "white", "[#ff0000]". */
export function resolveTailwindColor(token: string, palette = TAILWIND_COLORS): string | undefined {
  const t = token.trim();
  // Arbitrary value syntax: text-[#1a1a1a] or bg-[rgb(0,0,0)]
  const arbitrary = /^\[(.+)]$/.exec(t);
  if (arbitrary !== null) {
    return (arbitrary[1] as string).replace(/_/g, ' ');
  }
  const standalone = STANDALONE[t];
  if (standalone !== undefined) return standalone;

  // An opacity modifier (bg-green-500/10) is part of the colour, not decoration.
  //
  // This used to strip it, on the theory that a fully opaque reading is the conservative
  // one. That was wrong, and measurably so: a translucent *background* renders far closer
  // to whatever is behind it, so reading bg-green-500/10 as solid green-500 invents a
  // contrast failure that does not exist on screen. On one real component library that
  // single mistake produced eighteen confident, error-severity false positives out of
  // twenty-five contrast findings. The alpha is carried through and composited instead.
  const slash = t.indexOf('/');
  const base = slash >= 0 ? t.slice(0, slash) : t;
  const alpha = slash >= 0 ? parseOpacity(t.slice(slash + 1)) : 1;

  const dash = base.lastIndexOf('-');
  const solid = dash < 0 ? STANDALONE[base] : palette[base.slice(0, dash)]?.[base.slice(dash + 1)];
  if (solid === undefined) return undefined;
  return alpha >= 1 ? solid : withAlpha(solid, alpha);
}

/**
 * Read a Tailwind opacity modifier: `/50`, `/[0.06]`, `/[6%]`.
 *
 * An unreadable modifier returns 1 rather than a guess. That direction is deliberate:
 * treating an unknown alpha as opaque can only overstate a difference the tool then
 * refuses to patch, whereas guessing low would silence real failures.
 */
function parseOpacity(mod: string): number {
  const m = /^\[?(\d*\.?\d+)(%?)]?$/.exec(mod.trim());
  if (m === null) return 1;
  const n = parseFloat(m[1] as string);
  if (!Number.isFinite(n)) return 1;
  // Bare numbers are percentages in Tailwind (`/50` is 50%); a bracketed decimal
  // below 1 is already a fraction.
  const fraction = m[2] === '%' || n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, fraction));
}

/** Turn #rrggbb into an rgba() string carrying the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgbTriple(hex);
  if (rgb === null) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(alpha.toFixed(4))})`;
}

/**
 * Read the colour and typography utilities off a class list.
 *
 * Conditional variants (hover:, dark:, md:) are deliberately ignored: they describe a
 * state we are not evaluating, and folding them into the default would produce contrast
 * results for a combination that never renders together.
 */
export function resolveTailwindClasses(
  classList: string,
  palette = TAILWIND_COLORS,
): TailwindDecl {
  let color: string | undefined;
  let background: string | undefined;
  let borderColor: string | undefined;
  let fontSizePx: number | undefined;
  let bold: boolean | undefined;
  let backgroundUnknown = false;
  const unresolved: string[] = [];

  for (const raw of classList.split(/\s+/)) {
    const cls = raw.trim();
    if (cls === '') continue;
    // A variant prefix is separated by ':' — anything with one is state-conditional.
    if (cls.includes(':')) {
      const prefix = cls.slice(0, cls.indexOf(':'));
      if (CONDITIONAL.test(prefix)) continue;
    }

    if (PAINTS_NON_COLOUR.test(cls)) {
      backgroundUnknown = true;
      continue;
    }

    if (cls.startsWith('text-')) {
      const token = cls.slice(5);
      const size = TEXT_SIZES[token];
      if (size !== undefined) {
        fontSizePx = size;
        continue;
      }
      const arbitrarySize = /^\[(\d+(?:\.\d+)?)(px|rem)]$/.exec(token);
      if (arbitrarySize !== null) {
        const n = parseFloat(arbitrarySize[1] as string);
        fontSizePx = arbitrarySize[2] === 'rem' ? n * 16 : n;
        continue;
      }
      const resolved = resolveTailwindColor(token, palette);
      if (resolved !== undefined) color = resolved;
      else if (/^[a-z]+-\d{2,3}$/.test(token)) unresolved.push(cls);
      continue;
    }
    if (cls.startsWith('bg-')) {
      const resolved = resolveTailwindColor(cls.slice(3), palette);
      if (resolved !== undefined) background = resolved;
      else if (/^[a-z]+-\d{2,3}$/.test(cls.slice(3))) unresolved.push(cls);
      continue;
    }
    if (cls.startsWith('border-')) {
      const resolved = resolveTailwindColor(cls.slice(7), palette);
      if (resolved !== undefined) borderColor = resolved;
      continue;
    }
    if (cls.startsWith('font-')) {
      const weight = cls.slice(5);
      if (BOLD_WEIGHTS.has(weight)) bold = true;
      else if (weight === 'normal' || weight === 'light' || weight === 'thin') bold = false;
      continue;
    }
  }

  return {
    ...(backgroundUnknown ? { backgroundUnknown: true } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(borderColor !== undefined ? { borderColor } : {}),
    ...(fontSizePx !== undefined ? { fontSizePx } : {}),
    ...(bold !== undefined ? { bold } : {}),
    unresolved,
  };
}

/**
 * Find the Tailwind class whose resolved colour matches, so a fix can rewrite the class
 * rather than injecting an inline style. Rewriting `text-gray-400` to `text-gray-600`
 * is a patch a designer will accept; adding `style="color:#4b5563"` next to it is not.
 */
export function nearestShade(
  family: string,
  targetHex: string,
  palette = TAILWIND_COLORS,
): string | undefined {
  const shades = palette[family];
  if (shades === undefined) return undefined;
  const target = hexToRgbTriple(targetHex);
  if (target === null) return undefined;

  let best: { shade: string; dist: number } | undefined;
  for (const [shade, hex] of Object.entries(shades)) {
    const rgb = hexToRgbTriple(hex);
    if (rgb === null) continue;
    const d =
      (rgb[0] - target[0]) ** 2 + (rgb[1] - target[1]) ** 2 + (rgb[2] - target[2]) ** 2;
    if (best === undefined || d < best.dist) best = { shade, dist: d };
  }
  return best?.shade;
}

function hexToRgbTriple(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const v = m[1] as string;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** The colour family of a Tailwind class, e.g. "text-gray-400" -> "gray". */
export function familyOf(cls: string): string | undefined {
  const m = /^(?:text|bg|border)-([a-z]+)-\d{2,3}(?:\/\d+)?$/.exec(cls.trim());
  return m?.[1];
}

/**
 * The shades of a family beyond `from`, ordered outwards in one direction.
 *
 * `rampFrom('gray', '400', 'darker')` yields 500, 600, … 950. Callers walk this until a
 * shade actually clears the ratio they need, which is what a designer does and what
 * picking the palette entry nearest an ideal colour does not: the nearest entry to a
 * barely-darker ideal is very often the shade you started from.
 */
export function rampFrom(
  family: string,
  from: string,
  direction: 'darker' | 'lighter',
  palette = TAILWIND_COLORS,
): string[] {
  const shades = palette[family];
  if (shades === undefined) return [];
  const ordered = Object.keys(shades)
    .filter((s) => /^\d+$/.test(s))
    .map(Number)
    .sort((a, b) => a - b);
  const start = Number(from);
  if (!Number.isFinite(start)) return [];
  const beyond = direction === 'darker' ? ordered.filter((s) => s > start) : ordered.filter((s) => s < start).reverse();
  return beyond.map(String);
}

/** The numeric shade of a utility class, e.g. "text-gray-400" -> "400". */
export function shadeOf(cls: string): string | undefined {
  const m = /^(?:text|bg|border)-[a-z]+-(\d{2,3})(?:\/\S+)?$/.exec(cls.trim());
  return m?.[1];
}
