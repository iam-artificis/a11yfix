import type { Element, ParsedMarkup } from '../parse/markup.js';
import { getAttr } from '../parse/markup.js';
import { asSimpleSelector, isBoldWeight, lengthToPx, parseCss, parseInlineStyle } from '../parse/css.js';
import type { CssRule, Declaration } from '../parse/css.js';
import { resolveTailwindClasses } from './tailwind.js';
import { flatten, parseColor, toHex } from '../color.js';
import type { RGB } from '../color.js';
import type { TailwindDecl } from './tailwind.js';

/**
 * Resolving what colour an element actually renders in.
 *
 * The honest position of this whole module: colour resolution from source is possible
 * for some elements and impossible for others, and the difference must be visible in the
 * output. A checker that guesses at the hard cases produces confident wrong answers,
 * which for accessibility tooling is worse than silence — a developer who fixes a
 * hallucinated violation has spent effort and gained nothing, and stops trusting the tool.
 *
 * So every lookup returns either a value with a stated provenance, or nothing.
 */

export type Provenance =
  | 'inline-style'
  | 'tailwind'
  | 'stylesheet'
  | 'inherited'
  | 'default'
  /** Built by compositing one or more translucent layers over what is behind them. */
  | 'composited';

export interface ResolvedColor {
  /** CSS colour string, ready for parseColor(). */
  readonly value: string;
  readonly provenance: Provenance;
  /** The element the value came from, which may be an ancestor. */
  readonly from: Element;
  /**
   * Where in the source the value is written, so a fix can rewrite it in place.
   * Absent when the value was inherited or came from a stylesheet in another file.
   */
  readonly span?: { readonly start: number; readonly end: number; readonly file: string };
  /** The Tailwind class that produced it, when applicable, so a fix can swap the shade. */
  readonly tailwindClass?: string;
}

export interface Typography {
  readonly fontSizePx: number;
  readonly bold: boolean;
  readonly certain: boolean;
}

interface ElementStyle {
  color?: ResolvedColor;
  background?: ResolvedColor;
  /** Something is painted behind the text and we cannot reduce it to a colour. */
  backgroundUnknown?: boolean;
  fontSizePx?: number;
  bold?: boolean;
}

export interface StylesheetSource {
  readonly file: string;
  readonly content: string;
  /**
   * Directory this sheet is confined to, normally its package root. A file outside it
   * only sees this sheet if it names it in an import or a <link>. Absent means the sheet
   * applies everywhere, which is what a caller passing sheets by hand intends.
   */
  readonly scope?: string;
}

/**
 * The default background assumption.
 *
 * Browsers render an unstyled page on white, so an element with no background anywhere
 * in its ancestry is on white in practice. This is the one assumption the module makes,
 * it is marked `default` in the provenance, and callers may choose to skip such elements.
 */
const DEFAULT_BACKGROUND = '#ffffff';

export class Palette {
  private readonly styles = new Map<Element, ElementStyle>();
  private readonly cssRules: CssRule[] = [];
  /**
   * Rules that came from a <style> block in the very file being analysed. Only these
   * carry offsets a fix can write to; a rule from an external stylesheet describes a
   * different file, and patching it from here would edit the wrong thing.
   */
  private readonly embeddedRules = new Set<CssRule>();
  /** Custom properties from :root and @theme, used to resolve var() references. */
  private readonly variables: Record<string, string> = {};

  constructor(
    private readonly markup: ParsedMarkup,
    private readonly file: string,
    stylesheets: readonly StylesheetSource[] = [],
  ) {
    for (const sheet of stylesheets) {
      const parsed = parseCss(sheet.content);
      Object.assign(this.variables, parsed.rootVariables);
      // Conditional rules describe a state we are not evaluating (dark mode, a
      // breakpoint, a hover). Including them would mix colour pairs that never co-occur.
      for (const rule of parsed.rules) {
        if (rule.conditions.length === 0) this.cssRules.push(rule);
      }
    }
    // Stylesheets embedded in the document itself. Their offsets are shifted into
    // document coordinates so a fix can rewrite a colour inside a <style> block in
    // place — a very common case in plain HTML that would otherwise be unfixable.
    for (const el of markup.elements) {
      if (el.tagLower !== 'style' || el.innerSource === '') continue;
      const parsedEmbedded = parseCss(el.innerSource);
      Object.assign(this.variables, parsedEmbedded.rootVariables);
      for (const rule of parsedEmbedded.rules) {
        if (rule.conditions.length > 0) continue;
        this.cssRules.push({
          ...rule,
          start: rule.start + el.openEnd,
          end: rule.end + el.openEnd,
          declarations: rule.declarations.map((d) => ({
            ...d,
            propStart: d.propStart + el.openEnd,
            valueStart: d.valueStart + el.openEnd,
            valueEnd: d.valueEnd + el.openEnd,
          })),
        });
        this.embeddedRules.add(this.cssRules[this.cssRules.length - 1] as CssRule);
      }
    }
    for (const el of markup.elements) this.styles.set(el, this.computeOwn(el));
  }


  /**
   * Expand var(--token) references against the collected custom properties.
   *
   * Bounded recursion, because a token may point at another token — and because a
   * cyclic definition in a stylesheet must not hang the analyser.
   */
  resolveVar(value: string, depth = 0): string {
    if (depth > 8 || !value.includes('var(')) return value;
    const expanded = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string, fallback?: string) => {
      const found = this.variables[name];
      if (found !== undefined) return found.trim();
      return fallback !== undefined ? fallback.trim() : whole;
    });
    return expanded === value ? value : this.resolveVar(expanded, depth + 1);
  }


  /**
   * Fill in colours from design tokens that Tailwind's default palette cannot know about.
   *
   * Tailwind v4 turns `--color-fg-muted` declared in @theme into the utility class
   * `text-fg-muted`. Those classes carry the entire colour system of a modern codebase
   * and resolve to nothing without this step.
   */
  private withThemeTokens(tw: TailwindDecl, classes: readonly string[]): TailwindDecl {
    let color = tw.color;
    let background = tw.background;
    for (const cls of classes) {
      if (cls.includes(':')) continue;
      if (color === undefined && cls.startsWith('text-')) {
        const token = this.variables[`--color-${cls.slice(5)}`];
        if (token !== undefined) color = this.resolveVar(token);
      } else if (background === undefined && cls.startsWith('bg-')) {
        const token = this.variables[`--color-${cls.slice(3)}`];
        if (token !== undefined) background = this.resolveVar(token);
      }
    }
    return {
      ...tw,
      ...(color !== undefined ? { color } : {}),
      ...(background !== undefined ? { background } : {}),
    };
  }

  /** Styles set directly on this element, from any source. Later sources win. */
  private computeOwn(el: Element): ElementStyle {
    const out: ElementStyle = {};

    // 1. Stylesheet rules with a selector simple enough to attribute with certainty.
    const classAttr = getAttr(el, 'class') ?? getAttr(el, 'className');
    const classes = classAttr?.dynamic === true ? [] : (classAttr?.value ?? '').split(/\s+/).filter((c) => c !== '');
    const idAttr = getAttr(el, 'id');
    for (const rule of this.cssRules) {
      const matches = rule.selectors.some((sel) => {
        const simple = asSimpleSelector(sel);
        if (simple === null) return false;
        if (simple.kind === 'class') return classes.includes(simple.name);
        if (simple.kind === 'id') return idAttr?.value === simple.name;
        return simple.name === el.tagLower;
      });
      if (!matches) continue;
      this.absorb(out, rule.declarations, el, 'stylesheet', this.embeddedRules.has(rule) ? this.file : undefined);
    }

    // 2. Tailwind utilities in the class list.
    if (classes.length > 0) {
      const tw = this.withThemeTokens(resolveTailwindClasses(classes.join(' ')), classes);
      if (tw.color !== undefined && classAttr !== undefined) {
        out.color = {
          value: tw.color,
          provenance: 'tailwind',
          from: el,
          span: { start: classAttr.valueStart, end: classAttr.valueEnd, file: this.file },
          ...(findClass(classes, 'text-') !== undefined ? { tailwindClass: findClass(classes, 'text-') as string } : {}),
        };
      }
      if (tw.background !== undefined && classAttr !== undefined) {
        out.background = {
          value: tw.background,
          provenance: 'tailwind',
          from: el,
          span: { start: classAttr.valueStart, end: classAttr.valueEnd, file: this.file },
          ...(findClass(classes, 'bg-') !== undefined ? { tailwindClass: findClass(classes, 'bg-') as string } : {}),
        };
      }
      if (tw.backgroundUnknown === true && tw.background === undefined) out.backgroundUnknown = true;
      if (tw.fontSizePx !== undefined) out.fontSizePx = tw.fontSizePx;
      if (tw.bold !== undefined) out.bold = tw.bold;
    }

    // 3. Inline style wins over everything else on the same element.
    const styleAttr = getAttr(el, 'style');
    if (styleAttr !== undefined && !styleAttr.dynamic && styleAttr.value !== null) {
      const decls = parseInlineStyle(styleAttr.value, styleAttr.valueStart + 1);
      this.absorb(out, decls, el, 'inline-style', this.file);
    }

    return out;
  }

  private absorb(
    out: ElementStyle,
    decls: readonly Declaration[],
    el: Element,
    provenance: Provenance,
    file: string | undefined,
  ): void {
    for (const d of decls) {
      const span = file !== undefined ? { start: d.valueStart, end: d.valueEnd, file } : undefined;
      if (d.prop === 'color') {
        out.color = { value: d.value, provenance, from: el, ...(span !== undefined ? { span } : {}) };
      } else if (d.prop === 'background-color') {
        out.background = { value: d.value, provenance, from: el, ...(span !== undefined ? { span } : {}) };
      } else if (d.prop === 'background') {
        // The shorthand may carry a gradient or an image, in which case no single
        // backdrop colour exists. Saying nothing is not enough: the ancestor walk would
        // then step straight past this element to a colour that is painted over.
        const v = d.value.trim();
        if (/gradient|url\(/i.test(v)) {
          out.backgroundUnknown = true;
          delete out.background;
        } else {
          const colour = v.split(/\s+/).find((part) => /^(#|rgb|hsl|[a-z]+$)/i.test(part));
          if (colour !== undefined) {
            out.background = { value: colour, provenance, from: el, ...(span !== undefined ? { span } : {}) };
          }
        }
      } else if (d.prop === 'background-image') {
        if (d.value.trim().toLowerCase() !== 'none') {
          out.backgroundUnknown = true;
          delete out.background;
        }
      } else if (d.prop === 'font-size') {
        const px = lengthToPx(d.value);
        if (px !== undefined) out.fontSizePx = px;
      } else if (d.prop === 'font-weight') {
        out.bold = isBoldWeight(d.value);
      }
    }
  }

  /** The element's own text colour, or the nearest ancestor's, since colour inherits. */
  foregroundFor(el: Element): ResolvedColor | undefined {
    let node: Element | null = el;
    let depth = 0;
    while (node !== null && depth < 64) {
      const own = this.styles.get(node)?.color;
      if (own !== undefined) {
        const value = this.resolveVar(own.value);
        return node === el ? { ...own, value } : { ...own, value, provenance: 'inherited' };
      }
      node = node.parent;
      depth++;
    }
    return undefined;
  }

  /**
   * The backdrop an element renders against.
   *
   * Background does not inherit, but it does show through: an element with no background
   * of its own shows whatever its nearest ancestor painted. Walking up for that is
   * correct, unlike walking up for colour, which is inheritance proper.
   */
  backgroundFor(el: Element): ResolvedColor | undefined {
    // Translucent layers stack. `bg-black/10` inside `bg-white` renders as a very light
    // grey, not as black, so the walk cannot stop at the first background it meets — it
    // has to keep going until it finds something opaque and then composite back down.
    // Nearest-to-the-viewer first.
    const stack: RGB[] = [];
    let topmost: ResolvedColor | undefined;

    let node: Element | null = el;
    let depth = 0;
    while (node !== null && depth < 64) {
      const style = this.styles.get(node);
      if (style?.backgroundUnknown === true) return undefined;
      // A hero image, a video poster, a gradient scrim: the standard way to put one
      // behind text is a sibling stretched over the box with position:absolute. When one
      // of those is in the way, whatever colour an ancestor declares is not what the
      // text is actually sitting on.
      if (this.coveredByOverlay(node)) return undefined;
      const own = style?.background;
      if (own !== undefined && own.value !== 'transparent') {
        const value = this.resolveVar(own.value);
        const parsed = parseColor(value);
        if (parsed === null) {
          // A gradient, an image, or a custom property we could not follow. If it is the
          // only layer, hand it back and let the caller fail to parse it; if something
          // translucent sits on top of it, we genuinely do not know the result and must
          // say so rather than composite against a guess.
          return stack.length === 0 ? { ...own, value } : undefined;
        }
        if (topmost === undefined) topmost = own;
        if (parsed.a >= 1) return this.composite(stack, parsed, topmost, own);
        stack.push(parsed);
      }
      node = node.parent;
      depth++;
    }

    // Only assume the page default when we actually have a document to reason about.
    const hasDocument = this.markup.elements.some((e) => e.tagLower === 'body' || e.tagLower === 'html');
    if (!hasDocument) return undefined;
    const white = parseColor(DEFAULT_BACKGROUND);
    if (white === null) return undefined;
    if (stack.length === 0) return { value: DEFAULT_BACKGROUND, provenance: 'default', from: el };
    return this.composite(stack, white, topmost, undefined);
  }

  /**
   * Is this element overlaid by a positioned sibling that paints something?
   *
   * Deliberately narrow. A stretched sibling with no background and no media in it is
   * usually a focus ring or a click target, and suppressing findings for those would
   * cost more than it saves. The overlay has to actually paint: a background utility, a
   * gradient, or an <img>/<video>/<picture> inside it.
   */
  private coveredByOverlay(el: Element): boolean {
    const parent = el.parent;
    if (parent === null) return false;
    for (const sibling of parent.children) {
      if (sibling === el) continue;
      if (!isStretchedOverlay(sibling)) continue;
      if (paintsSomething(sibling)) return true;
    }
    return false;
  }

  /** Flatten a stack of translucent layers onto an opaque base, viewer-side last. */
  private composite(
    stack: readonly RGB[],
    base: RGB,
    topmost: ResolvedColor | undefined,
    opaqueLayer: ResolvedColor | undefined,
  ): ResolvedColor {
    if (stack.length === 0 && opaqueLayer !== undefined) {
      return { ...opaqueLayer, value: toHex(base) };
    }
    let acc = base;
    for (let i = stack.length - 1; i >= 0; i--) acc = flatten(stack[i] as RGB, acc);
    // The span and Tailwind class come from the topmost layer, because that is the
    // declaration a developer would edit to change what they see.
    const anchor = topmost ?? opaqueLayer;
    if (anchor === undefined) return { value: toHex(acc), provenance: 'composited', from: this.markup.elements[0] as Element };
    const out: ResolvedColor = { ...anchor, value: toHex(acc), provenance: 'composited' };
    return out;
  }

  /**
   * Font size and weight, with `certain` false when we fell back to the 16px default.
   * This matters: WCAG's threshold drops from 4.5:1 to 3:1 for large text, so an
   * uncertain size can flip a violation into a pass or the reverse.
   */
  typographyFor(el: Element): Typography {
    let size: number | undefined;
    let bold: boolean | undefined;
    let node: Element | null = el;
    let depth = 0;
    while (node !== null && depth < 64) {
      const own = this.styles.get(node);
      if (size === undefined && own?.fontSizePx !== undefined) size = own.fontSizePx;
      if (bold === undefined && own?.bold !== undefined) bold = own.bold;
      if (size !== undefined && bold !== undefined) break;
      node = node.parent;
      depth++;
    }
    // Heading tags carry a default size large enough to change the threshold.
    const headingDefaults: Readonly<Record<string, number>> = {
      h1: 32, h2: 24, h3: 18.72, h4: 16, h5: 13.28, h6: 10.72,
    };
    const tagDefault = headingDefaults[el.tagLower];
    const certain = size !== undefined || tagDefault !== undefined;
    return {
      fontSizePx: size ?? tagDefault ?? 16,
      bold: bold ?? (tagDefault !== undefined),
      certain,
    };
  }
}

function findClass(classes: readonly string[], prefix: string): string | undefined {
  return classes.find((c) => c.startsWith(prefix) && !c.includes(':'));
}

/** `position: absolute|fixed` plus offsets that stretch the element over its parent. */
function isStretchedOverlay(el: Element): boolean {
  const classAttr = getAttr(el, 'class') ?? getAttr(el, 'className');
  const classes = classAttr?.dynamic === true ? [] : (classAttr?.value ?? '').split(/\s+/);
  const positioned = classes.includes('absolute') || classes.includes('fixed');
  const stretched =
    classes.includes('inset-0') ||
    (classes.includes('top-0') && classes.includes('bottom-0')) ||
    (classes.includes('h-full') && classes.includes('w-full'));
  if (positioned && stretched) return true;

  const style = getAttr(el, 'style');
  if (style === undefined || style.dynamic || style.value === null) return false;
  const s = style.value.toLowerCase();
  return /position\s*:\s*(absolute|fixed)/.test(s) && /\binset\s*:\s*0/.test(s);
}

/** Does this subtree put anything visible behind the text? */
function paintsSomething(el: Element): boolean {
  const stack: Element[] = [el];
  let seen = 0;
  while (stack.length > 0 && seen < 200) {
    const node = stack.pop() as Element;
    seen++;
    if (node.tagLower === 'img' || node.tagLower === 'video' || node.tagLower === 'picture') return true;
    const classAttr = getAttr(node, 'class') ?? getAttr(node, 'className');
    const value = classAttr?.dynamic === true ? '' : (classAttr?.value ?? '');
    if (/(^|\s)bg-\S/.test(value)) return true;
    const style = getAttr(node, 'style');
    if (style !== undefined && !style.dynamic && style.value !== null && /background/i.test(style.value)) {
      return true;
    }
    stack.push(...node.children);
  }
  return false;
}
