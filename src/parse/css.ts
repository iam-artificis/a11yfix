/**
 * A small CSS reader that keeps source offsets.
 *
 * This is not a cascade engine and does not pretend to be one. Resolving what colour a
 * given element actually renders in requires specificity, inheritance, media queries,
 * container queries, custom-property indirection and the DOM — none of which are
 * available when reading files. Claiming otherwise is how automated accessibility tools
 * end up reporting confident nonsense.
 *
 * What it does instead is narrow and honest: read the declarations, and leave the
 * question of which elements a selector reaches to `src/design/selector.ts`, which
 * accepts only selectors whose effect can be decided by looking at the element and its
 * ancestors — a compound, a descendant, a child — and refuses everything whose answer
 * depends on state, on attributes, or on sibling order. What it refuses is reported as
 * undetermined rather than guessed at.
 */

export interface Declaration {
  readonly prop: string;
  readonly value: string;
  readonly propStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

export interface CssRule {
  readonly selector: string;
  /** Individual comma-separated selectors, trimmed. */
  readonly selectors: readonly string[];
  readonly declarations: readonly Declaration[];
  readonly start: number;
  readonly end: number;
  /**
   * Enclosing at-rules, outermost first, e.g. ["@media (prefers-color-scheme: dark)"].
   * A declaration inside one of these does not describe the default rendering, so
   * contrast rules must not silently treat it as the element's colour.
   */
  readonly conditions: readonly string[];
}

export interface ParsedCss {
  readonly rules: readonly CssRule[];
  /** Custom properties declared on :root, which Tailwind v4 uses for its theme. */
  readonly rootVariables: Readonly<Record<string, string>>;
}

/** Strip comments while preserving length, so every offset stays valid. */
function blankComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      // Keep newlines so line numbers survive.
      for (let k = i; k < end; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = end;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function parseDeclarations(src: string, from: number, to: number): Declaration[] {
  const out: Declaration[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /[\s;]/.test(src[i] as string)) i++;
    if (i >= to) break;
    const propStart = i;
    while (i < to && src[i] !== ':' && src[i] !== ';' && src[i] !== '}') i++;
    if (src[i] !== ':') {
      // Malformed or a nested block we do not handle; skip to the next semicolon.
      while (i < to && src[i] !== ';') i++;
      continue;
    }
    const prop = src.slice(propStart, i).trim();
    i++; // ':'
    while (i < to && /\s/.test(src[i] as string)) i++;
    const valueStart = i;
    let depth = 0;
    let quote: string | null = null;
    while (i < to) {
      const ch = src[i] as string;
      if (quote !== null) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ';' || ch === '}') && depth <= 0) break;
      i++;
    }
    const valueEnd = i;
    const value = src.slice(valueStart, valueEnd).trim();
    if (prop !== '' && value !== '') {
      out.push({ prop: prop.toLowerCase(), value, propStart, valueStart, valueEnd });
    }
    if (src[i] === ';') i++;
  }
  return out;
}

/** Parse a stylesheet. Never throws; unparseable regions are skipped. */
export function parseCss(source: string): ParsedCss {
  const src = blankComments(source);
  const rules: CssRule[] = [];
  const rootVariables: Record<string, string> = {};
  const conditions: string[] = [];

  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (i >= src.length) break;

    if (src[i] === '}') {
      conditions.pop();
      i++;
      continue;
    }

    const preludeStart = i;
    let depth = 0;
    let quote: string | null = null;
    while (i < src.length) {
      const ch = src[i] as string;
      if (quote !== null) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === '{' || ch === ';') && depth <= 0) break;
      i++;
    }
    const prelude = src.slice(preludeStart, i).trim();

    if (src[i] === ';') {
      // A statement at-rule such as @import; nothing to record.
      i++;
      continue;
    }
    if (src[i] !== '{') break;
    const bodyStart = i + 1;

    if (prelude.startsWith('@')) {
      const name = prelude.split(/[\s(]/)[0] as string;
      // Conditional groups nest rules; @keyframes and @font-face do not contain
      // selectors we care about, so their bodies are skipped wholesale.
      if (name === '@media' || name === '@supports' || name === '@container' || name === '@layer' || name === '@scope') {
        conditions.push(prelude);
        i = bodyStart;
        continue;
      }
      // Tailwind v4 declares the entire design system inside @theme, as custom
      // properties. Skipping it would leave every colour in a modern codebase
      // unresolvable, which is most of what this tool needs to read.
      if (name === '@theme') {
        const themeEnd = findBlockEnd(src, bodyStart);
        for (const d of parseDeclarations(src, bodyStart, themeEnd)) {
          if (d.prop.startsWith('--')) rootVariables[d.prop] = d.value;
        }
        i = themeEnd + 1;
        continue;
      }
      i = skipBlock(src, bodyStart);
      continue;
    }

    const bodyEnd = findBlockEnd(src, bodyStart);
    const declarations = parseDeclarations(src, bodyStart, bodyEnd);
    const selectors = splitSelectors(prelude);

    if (selectors.some((s) => s === ':root' || s === 'html')) {
      for (const d of declarations) {
        if (d.prop.startsWith('--')) rootVariables[d.prop] = d.value;
      }
    }

    rules.push({
      selector: prelude,
      selectors,
      declarations,
      start: preludeStart,
      end: bodyEnd,
      conditions: [...conditions],
    });
    i = bodyEnd + 1;
  }

  return { rules, rootVariables };
}

function findBlockEnd(src: string, from: number): number {
  let depth = 1;
  let i = from;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i] as string;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return src.length;
}

function skipBlock(src: string, from: number): number {
  return findBlockEnd(src, from) + 1;
}

/** Split a selector list on commas that are not inside brackets or parentheses. */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') out.push(buf.trim());
  return out;
}

/** Parse a `style="..."` attribute into declarations, with offsets relative to `base`. */
export function parseInlineStyle(style: string, base: number): Declaration[] {
  return parseDeclarations(style, 0, style.length).map((d) => ({
    ...d,
    propStart: d.propStart + base,
    valueStart: d.valueStart + base,
    valueEnd: d.valueEnd + base,
  }));
}

/** Convert a CSS length to px where it is statically determinable. */
export function lengthToPx(value: string, rootPx = 16): number | undefined {
  const m = /^(-?\d*\.?\d+)(px|rem|em|pt|%)?$/.exec(value.trim());
  if (m === null) return undefined;
  const n = parseFloat(m[1] as string);
  switch (m[2]) {
    case undefined:
    case 'px':
      return n;
    case 'rem':
      return n * rootPx;
    // `em` and `%` are relative to the parent's computed size, which we do not know.
    // Returning a number here would silently assume 16px and could misclassify text as
    // "large", which changes the required contrast ratio from 4.5 to 3.
    case 'em':
    case '%':
      return undefined;
    case 'pt':
      return (n * 4) / 3;
    default:
      return undefined;
  }
}

/**
 * A font-size expressed as a multiple of the parent's, or undefined when it is not one.
 *
 * `lengthToPx` cannot answer for `em` and `%` because it has no element to look up
 * from. The caller does, so it gets the factor and does the multiplying: 2em on a 12px
 * parent is 24px, which is large text and needs 3:1 rather than 4.5:1.
 */
export function relativeFontFactor(value: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(em|%)$/.exec(value.trim());
  if (m === null) return undefined;
  const n = parseFloat(m[1] as string);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return m[2] === '%' ? n / 100 : n;
}

/** Is this font-weight bold enough for WCAG's "large bold text" allowance? */
export function isBoldWeight(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'bold' || v === 'bolder') return true;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 700;
}
