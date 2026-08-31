import type { Element, ParsedMarkup } from '../parse/markup.js';
import { getAttr } from '../parse/markup.js';
import { isBoldWeight, lengthToPx, parseCss, parseInlineStyle, relativeFontFactor } from '../parse/css.js';
import type { ParsedSelector } from './selector.js';
import { matchesSelector, parseSelector } from './selector.js';
import type { CssRule, Declaration } from '../parse/css.js';
import { resolveTailwindClasses, resolveTailwindColor } from './tailwind.js';
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
  /**
   * What sits behind this layer, when the layer itself is translucent.
   *
   * `value` is the composited result — the colour a viewer sees — which is the right
   * answer for measuring contrast and the wrong one for changing it. A fix that swaps
   * `bg-red-600/60` for a darker shade writes a colour that will composite over the
   * backdrop again, so verifying it needs the backdrop, not the old composite.
   */
  readonly behind?: string;
  /**
   * True when the bottom of the stack is the assumed page default rather than a colour
   * anything actually declared.
   *
   * `provenance` cannot carry this: a translucent layer composited onto the assumption is
   * `'composited'`, which reads as "we worked it out" when the truthful answer is "we
   * worked it out from a guess". Without the distinction, the uncertainty guard in
   * contrast.ts saw only the word composited and let three findings through on spbu.ru
   * saying white text sits on light grey — inside a slider whose real backdrop is a
   * photograph.
   */
  readonly assumedBase?: boolean;
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
  /**
   * A font-size declared as a multiple of the parent's — `2em`, `150%`. Recorded rather
   * than dropped: without it the inheritance walk sails past this element and adopts an
   * ancestor's pixels as if they were its own, so a 24px callout was judged against the
   * 4.5:1 threshold for small text and reported as failing when it passes.
   */
  fontSizeFactor?: number;
  /** A font-size was declared in a unit we cannot resolve at all (vw, calc, clamp). */
  fontSizeUnknown?: boolean;
  bold?: boolean;
  /** A font-weight was declared in a form we cannot decide (var(), inherit, calc()). */
  boldUnknown?: boolean;
  /**
   * Resolved box properties, kept only for the overlay test and only when one of them was
   * declared. See `BOX_PROPS`.
   */
  box?: Record<string, string>;
}

/**
 * The properties that decide whether an element is stretched over its siblings.
 *
 * Collected through the same cascade as colour, because the overlay test used to read
 * the class attribute and the inline style and nothing else — which is a test for
 * Tailwind. Bitrix, Drupal, Nuxt and every hand-rolled theme put positioning in a
 * stylesheet, so on rsl.ru the card image that covers the text was invisible to it and
 * forty-five white headings were reported as white-on-near-white.
 */
const BOX_PROPS = new Set(['position', 'inset', 'top', 'right', 'bottom', 'left', 'width', 'height']);

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

/**
 * The tokens of a shorthand value, split on whitespace that is outside brackets.
 *
 * A plain split tears `var(--black, #000)` and `rgb(0, 0, 0)` in half, and the half that
 * survives parses as nothing — which is how a page ends up with no background at all
 * rather than the one it declared.
 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch)) {
      if (i > start) parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (start < value.length) parts.push(value.slice(start));
  return parts;
}

/**
 * Components of a `background` shorthand that carry no colour and hide nothing.
 *
 * A shorthand made only of these paints nothing, so the element is transparent and the
 * walk should continue past it. Anything outside this set that is also not a colour is a
 * value we do not understand, and the safe reading of that is "unknown", not "white".
 */
const BACKGROUND_KEYWORDS = new Set([
  'none', 'repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round',
  'scroll', 'fixed', 'local', 'center', 'top', 'bottom', 'left', 'right',
  'cover', 'contain', 'auto', 'border-box', 'padding-box', 'content-box',
]);

function isBackgroundMetric(part: string): boolean {
  return part === '/' || /^[+-]?(?:\d*\.)?\d+(?:px|em|rem|%|vw|vh|vmin|vmax|pt|pc|cm|mm|in|ex|ch|q)?$/i.test(part);
}

export class Palette {
  private readonly styles = new Map<Element, ElementStyle>();
  /** Per parent: the children that paint over their siblings. See coveredByOverlay. */
  private readonly overlayCache = new Map<Element, Element[]>();
  /** Same reasoning as overlayCache: every descendant asks this of the same ancestors. */
  private readonly floatsCache = new Map<Element, boolean>();
  private readonly cssRules: CssRule[] = [];
  /** Selector key -> the rules carrying it, with their specificity and source position. */
  private readonly ruleIndex = new Map<string, { rank: number; index: number; sel: ParsedSelector }[]>();
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
      const parsed = parseSheet(sheet);
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
    this.buildRuleIndex();
    for (const el of markup.elements) this.styles.set(el, this.computeOwn(el));
  }

  /**
   * Group the rules by what their selector has to match: `t:div`, `c:hint`, `i:alert`.
   *
   * Only the three simple selector shapes are attributable with certainty, so the full
   * specificity triple collapses to one rank, recorded here alongside the rule's position
   * in source order.
   */
  private buildRuleIndex(): void {
    this.cssRules.forEach((rule, index) => {
      for (const sel of rule.selectors) {
        const parsed = parseSelector(sel);
        if (parsed === null) continue;
        const bucket = this.ruleIndex.get(parsed.key);
        const entry = { rank: parsed.specificity, index, sel: parsed };
        if (bucket === undefined) this.ruleIndex.set(parsed.key, [entry]);
        else bucket.push(entry);
      }
    });
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

    // Applied weakest selector first, because `absorb` lets each later rule overwrite the
    // one before it. Source order alone is not the cascade: `#alert { color:#111 }`
    // followed by `.hint { color:#ccc }` renders as #111 in every browser, and taking the
    // later rule reported 1.61:1 on text the page draws at 18.9:1. External sheets are
    // also all collected before embedded <style> rules, so source order was doubly wrong.
    //
    // Only the three simple selector shapes reach here, so the full specificity triple
    // collapses to one rank. Sort is stable, which leaves source order as the tie-break
    // between selectors of equal weight — which is what the cascade says.
    //
    // Looked up rather than scanned. Testing every rule against every element re-parsed
    // each selector with a regex once per element: 800 rules over 800 elements is 640,000
    // parses of the same eighty strings. The index is built once and keyed on the thing
    // that has to match, so an element only meets rules that name its tag, its id or one
    // of its classes.
    const matched: { rank: number; index: number }[] = [];
    const best = new Map<number, number>();
    const collect = (key: string): void => {
      const hits = this.ruleIndex.get(key);
      if (hits === undefined) return;
      for (const hit of hits) {
        // The index narrows by the subject's own tag, id or class; the ancestor half of
        // the selector still has to be checked against the tree.
        if (!matchesSelector(el, hit.sel)) continue;
        // A rule may list several selectors; the one that matches most specifically wins.
        const prev = best.get(hit.index);
        if (prev === undefined || hit.rank > prev) best.set(hit.index, hit.rank);
      }
    };
    collect('t:' + el.tagLower);
    if (idAttr?.value != null) collect('i:' + idAttr.value);
    for (const c of classes) collect('c:' + c);
    for (const [index, rank] of best) matched.push({ index, rank });

    // Source order is the tie-break between selectors of equal weight, which is what the
    // cascade says; with rules gathered from three buckets it has to be explicit.
    matched.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index));
    for (const { index } of matched) {
      const rule = this.cssRules[index] as CssRule;
      this.absorb(out, rule.declarations, el, 'stylesheet', this.embeddedRules.has(rule) ? this.file : undefined, false);
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
          ...(colourClass(classes, 'text-') !== undefined
            ? { tailwindClass: colourClass(classes, 'text-') as string }
            : {}),
        };
      }
      if (tw.background !== undefined && classAttr !== undefined) {
        out.background = {
          value: tw.background,
          provenance: 'tailwind',
          from: el,
          span: { start: classAttr.valueStart, end: classAttr.valueEnd, file: this.file },
          ...(colourClass(classes, 'bg-') !== undefined
            ? { tailwindClass: colourClass(classes, 'bg-') as string }
            : {}),
        };
      }
      if (tw.backgroundUnknown === true && tw.background === undefined) out.backgroundUnknown = true;
      if (tw.fontSizePx !== undefined) out.fontSizePx = tw.fontSizePx;
      if (tw.bold !== undefined) out.bold = tw.bold;
    }

    // 3. Inline style wins over everything else on the same element — until step 4.
    const styleAttr = getAttr(el, 'style');
    const inline =
      styleAttr !== undefined && !styleAttr.dynamic && styleAttr.value !== null
        ? parseInlineStyle(styleAttr.value, styleAttr.valueStart + 1)
        : undefined;
    if (inline !== undefined) this.absorb(out, inline, el, 'inline-style', this.file, false);

    // 4. `!important`, in the same order again.
    //
    // The cascade is not one pass with inline at the end. Within the author origin it is
    // normal declarations by specificity, then the inline attribute, then `!important`
    // declarations by specificity, then inline `!important` — so a stylesheet marked
    // important beats an inline style, which is the arrangement every CMS theme uses to
    // hold its own against a component's inline attributes. Running the same two lists a
    // second time, filtered the other way, is the whole of it.
    for (const { index } of matched) {
      const rule = this.cssRules[index] as CssRule;
      this.absorb(out, rule.declarations, el, 'stylesheet', this.embeddedRules.has(rule) ? this.file : undefined, true);
    }
    if (inline !== undefined) this.absorb(out, inline, el, 'inline-style', this.file, true);

    return out;
  }

  private absorb(
    out: ElementStyle,
    decls: readonly Declaration[],
    el: Element,
    provenance: Provenance,
    file: string | undefined,
    /** Which half of the cascade this pass is applying. */
    important: boolean,
  ): void {
    for (const d of decls) {
      if ((d.important ?? false) !== important) continue;
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
          const parts = splitTopLevel(v);
          // A custom property is kept whole and resolved later, exactly as `color:
          // var(--x)` already is. shm.ru declares `background: var(--black)` on the block
          // its white headings sit in; reading that as "no background" put every one of
          // them on the page default and reported white on white, twenty-nine times.
          const colour = parts.find((part) => /^var\(/i.test(part) || parseColor(part) !== null);
          if (colour !== undefined) {
            out.background = { value: colour, provenance, from: el, ...(span !== undefined ? { span } : {}) };
            // The shorthand resets background-image, so whatever made this unknown is
            // painted over by what we just read.
            delete out.backgroundUnknown;
          } else if (
            parts.every(
              (part) => BACKGROUND_KEYWORDS.has(part.toLowerCase()) || isBackgroundMetric(part),
            )
          ) {
            // Position, size and repeat only: the element paints nothing and the walk
            // should carry on past it.
            delete out.background;
          } else {
            // Something we do not understand — `inherit`, an unresolved function, a
            // vendor value. Guessing white here is how a dark section becomes eight
            // findings about text that is perfectly readable.
            out.backgroundUnknown = true;
            delete out.background;
          }
        }
      } else if (d.prop === 'background-image') {
        if (d.value.trim().toLowerCase() !== 'none') {
          out.backgroundUnknown = true;
          delete out.background;
        }
      } else if (d.prop === 'font-size') {
        const px = lengthToPx(d.value);
        const factor = px === undefined ? relativeFontFactor(d.value) : undefined;
        delete out.fontSizePx;
        delete out.fontSizeFactor;
        delete out.fontSizeUnknown;
        if (px !== undefined) out.fontSizePx = px;
        else if (factor !== undefined) out.fontSizeFactor = factor;
        else out.fontSizeUnknown = true;
      } else if (d.prop === 'font-weight') {
        const b = isBoldWeight(d.value);
        delete out.bold;
        delete out.boldUnknown;
        if (b === undefined) out.boldUnknown = true;
        else out.bold = b;
      } else if (BOX_PROPS.has(d.prop)) {
        (out.box ??= {})[d.prop] = d.value.trim().toLowerCase();
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
      // The mirror of the test above. That one asks whether something covers this box;
      // this one asks whether the box is itself floating over something — which is the
      // commoner arrangement by far, and was not checked at all.
      //
      // spbu.ru's slider is the shape: `.slider-content { position: absolute; bottom: 0 }`
      // holding the caption, laid over a sibling `.slider__media` that carries the
      // photograph. Walking up from the caption found white four levels above and
      // composited a scrim onto it, giving ten findings of white text on #cccccc. The
      // white is real; it is simply not what is behind this text.
      //
      // Only asked once the element's own background has failed to settle the question,
      // so an absolutely positioned dropdown that paints itself opaque still answers
      // normally.
      if (this.floatsOverPaintedSibling(node)) return undefined;
      node = node.parent;
      depth++;
    }

    // Only assume the page default when we actually have a document to reason about.
    const hasDocument = this.markup.elements.some((e) => e.tagLower === 'body' || e.tagLower === 'html');
    if (!hasDocument) return undefined;
    const white = parseColor(DEFAULT_BACKGROUND);
    if (white === null) return undefined;
    if (stack.length === 0) return { value: DEFAULT_BACKGROUND, provenance: 'default', from: el };
    return { ...this.composite(stack, white, topmost, undefined), assumedBase: true };
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
    // Which children of a parent are overlays is a property of the parent, so it is
    // answered once. Asking it per element re-read every sibling for every sibling: a
    // flat page of 2000 paragraphs — a changelog, a search-results list, a table of
    // contents — spent most of its scan comparing each one to all the others.
    let overlays = this.overlayCache.get(parent);
    if (overlays === undefined) {
      overlays = parent.children.filter(
        (c) => isStretchedOverlay(c, this.styles.get(c)?.box) && this.paintsSomething(c),
      );
      this.overlayCache.set(parent, overlays);
    }
    for (const overlay of overlays) {
      if (overlay !== el) return true;
    }
    return false;
  }

  /**
   * Is this element taken out of flow and laid over a sibling that paints?
   *
   * Weaker than `isStretchedOverlay` on purpose: that one has to prove a box covers its
   * siblings, which warrants demanding it be stretched across them. Here the element is
   * already known to be the thing in front, and the only question is whether anything is
   * behind it — for which `position: absolute` and one painted sibling is the whole test.
   */
  private floatsOverPaintedSibling(el: Element): boolean {
    const cached = this.floatsCache.get(el);
    if (cached !== undefined) return cached;
    const answer = this.computeFloatsOver(el);
    this.floatsCache.set(el, answer);
    return answer;
  }

  private computeFloatsOver(el: Element): boolean {
    const box = this.styles.get(el)?.box;
    const classAttr = getAttr(el, 'class') ?? getAttr(el, 'className');
    const classes = classAttr?.dynamic === true ? [] : (classAttr?.value ?? '').split(/\s+/);
    const positioned =
      box?.position === 'absolute' ||
      box?.position === 'fixed' ||
      classes.includes('absolute') ||
      classes.includes('fixed');
    if (!positioned) return false;
    const parent = el.parent;
    if (parent === null) return false;
    for (const sib of parent.children) {
      if (sib !== el && this.paintsSomething(sib)) return true;
    }
    return false;
  }

  /**
   * Does this subtree put anything visible behind the text?
   *
   * Deliberately does **not** consult the resolved background, though the sibling test
   * above now does read the cascade. Trying it both ways on the corpus settled it: taking
   * any stylesheet background as proof of an overlay suppressed thirty more findings on
   * fronts, of which only ten were inventions — the other twenty included grey-on-white
   * at 2.78:1 and white on a mid-green badge at 4.23:1, which are exactly the findings
   * this tool exists to make. A dropdown panel is absolutely positioned, full width and
   * painted white, and it covers nothing until someone opens it. The near-white
   * inventions this would have caught are handled where they belong, by the uncertainty
   * guard in contrast.ts, which does not have to guess at stacking order to be right.
   */
  private paintsSomething(el: Element): boolean {
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
    // Everything below the topmost layer, kept separately: it is the backdrop a
    // replacement for that layer would be painted on.
    let acc = base;
    for (let i = stack.length - 1; i >= 1; i--) acc = flatten(stack[i] as RGB, acc);
    const behind = stack.length > 0 ? toHex(acc) : undefined;
    if (stack.length > 0) acc = flatten(stack[0] as RGB, acc);
    // The span and Tailwind class come from the topmost layer, because that is the
    // declaration a developer would edit to change what they see.
    const anchor = topmost ?? opaqueLayer;
    if (anchor === undefined) return { value: toHex(acc), provenance: 'composited', from: this.markup.elements[0] as Element };
    const out: ResolvedColor = {
      ...anchor,
      value: toHex(acc),
      provenance: 'composited',
      ...(behind !== undefined ? { behind } : {}),
    };
    return out;
  }

  /**
   * Font size and weight, with `certain` false when we fell back to the 16px default.
   * This matters: WCAG's threshold drops from 4.5:1 to 3:1 for large text, so an
   * uncertain size can flip a violation into a pass or the reverse.
   */
  typographyFor(el: Element): Typography {
    let size: number | undefined;
    // Multiples collected on the way up, applied to the first absolute size found.
    // `0.9em` inside `2em` inside `12px` is 21.6px, and each step has to be kept.
    const factors: number[] = [];
    let unknown = false;
    let bold: boolean | undefined;
    let boldUnknown = false;
    let node: Element | null = el;
    let depth = 0;
    while (node !== null && depth < 64) {
      const own = this.styles.get(node);
      if (size === undefined && !unknown) {
        if (own?.fontSizePx !== undefined) size = own.fontSizePx;
        else if (own?.fontSizeFactor !== undefined) factors.push(own.fontSizeFactor);
        else if (own?.fontSizeUnknown === true) unknown = true;
      }
      if (bold === undefined && !boldUnknown) {
        if (own?.bold !== undefined) bold = own.bold;
        else if (own?.boldUnknown === true) boldUnknown = true;
      }
      if ((size !== undefined || unknown) && (bold !== undefined || boldUnknown)) break;
      node = node.parent;
      depth++;
    }
    // Heading tags carry a default size large enough to change the threshold.
    const headingDefaults: Readonly<Record<string, number>> = {
      h1: 32, h2: 24, h3: 18.72, h4: 16, h5: 13.28, h6: 10.72,
    };
    const tagDefault = headingDefaults[el.tagLower];

    // The element's own relative sizes multiply whatever absolute size the walk found.
    // Without a base there is nothing to multiply, and the size stays unknown rather than
    // being assumed: guessing 16px is what makes a checker confidently wrong.
    const base = size ?? (factors.length > 0 ? undefined : tagDefault);
    const resolved =
      size !== undefined ? factors.reduce((n, f) => n * f, size) : tagDefault;
    const px = resolved ?? base ?? 16;
    // An undecidable weight only changes the verdict between 18.66px and 24px: below that
    // band nothing is large text and above it everything is, whether or not it is bold.
    // Widening the doubt beyond the band would suppress real findings on small text for
    // no reason, which is the failure this whole flag exists to avoid in the other
    // direction.
    const weightCouldDecide = boldUnknown && px >= 18.66 && px < 24;
    const certain = !unknown && resolved !== undefined && !weightCouldDecide;
    return {
      fontSizePx: px,
      bold: bold ?? (tagDefault !== undefined),
      certain,
    };
  }
}

/**
 * Parsed stylesheets, keyed by the source object the caller handed us.
 *
 * A Palette is built per file and the same stylesheet objects are shared across the whole
 * run, so parsing them in the constructor meant re-parsing every sheet for every file: on
 * a repository with 70 stylesheets and 3300 source files that is 230,000 parses of text
 * that never changed, and it was the difference between a scan taking twenty-three
 * seconds and under two.
 *
 * A WeakMap rather than a content-keyed Map so nothing is retained after a run, and so
 * two sheets that happen to have identical contents in different packages stay distinct.
 */
const parsedSheets = new WeakMap<StylesheetSource, ReturnType<typeof parseCss>>();

function parseSheet(sheet: StylesheetSource): ReturnType<typeof parseCss> {
  const hit = parsedSheets.get(sheet);
  if (hit !== undefined) return hit;
  const parsed = parseCss(sheet.content);
  parsedSheets.set(sheet, parsed);
  return parsed;
}

function findClass(classes: readonly string[], prefix: string): string | undefined {
  return classes.find((c) => c.startsWith(prefix) && !c.includes(':'));
}

/**
 * The `text-`/`bg-` class that actually set a colour.
 *
 * Not the first one with the prefix: `text-` also prefixes every font-size utility, and
 * prettier-plugin-tailwindcss sorts sizes before colours, so `class="text-sm
 * text-gray-400"` — the commonest way it is written — handed `text-sm` to the fix
 * builder. That has no family or shade, so the builder gave up and the finding was
 * downgraded to "the colour is not written in a form this tool can rewrite in place",
 * which was untrue: it is written right there as `text-gray-400`.
 *
 * Falls back to the first prefixed class so an arbitrary-value utility the resolver does
 * not understand still names something rather than nothing.
 */
function colourClass(classes: readonly string[], prefix: string): string | undefined {
  const resolved = classes.find(
    (c) =>
      c.startsWith(prefix) &&
      !c.includes(':') &&
      resolveTailwindColor(c.slice(prefix.length).replace(/\/.*$/, '')) !== undefined,
  );
  return resolved ?? findClass(classes, prefix);
}

/** `position: absolute|fixed` plus offsets that stretch the element over its parent. */
/** `0`, `0px`, `0%`, `0rem` — anything that resolves to no offset at all. */
function isZeroLength(value: string | undefined): boolean {
  return value !== undefined && /^0(?:[a-z%]*)$/.test(value.trim());
}

/** `100%`, and the `100vw`/`100vh` a full-bleed overlay is just as often written with. */
function isFullLength(value: string | undefined): boolean {
  return value !== undefined && /^100(?:%|vw|vh)$/.test(value.trim());
}

/**
 * Does this element cover its siblings?
 *
 * The box properties come from the cascade, so a rule in a stylesheet counts the same as
 * a Tailwind class or an inline attribute. Before that they did not: the test read the
 * class list for Tailwind's spellings and the `style` attribute for `inset:0`, which
 * between them describe one framework and one abbreviation. Every site in the Russian
 * corpus positions in a `.css` file, so the guard never fired for any of them and forty-
 * five findings on one library's site said white text sat on near-white — under a
 * photograph.
 *
 * Still deliberately narrow. Being wrong in this direction hides a real finding, so the
 * element has to be both taken out of flow and stretched across what it covers.
 */
function isStretchedOverlay(el: Element, box: Record<string, string> | undefined): boolean {
  const classAttr = getAttr(el, 'class') ?? getAttr(el, 'className');
  const classes = classAttr?.dynamic === true ? [] : (classAttr?.value ?? '').split(/\s+/);
  const positioned =
    classes.includes('absolute') ||
    classes.includes('fixed') ||
    box?.position === 'absolute' ||
    box?.position === 'fixed';
  if (!positioned) return false;

  // `inset: 0` and `inset: 0 0 0 0` both mean the four offsets; anything with a non-zero
  // component does not stretch and is left alone.
  const inset = box?.inset;
  const insetZero =
    inset !== undefined && inset.split(/\s+/).every((part) => isZeroLength(part));

  return (
    classes.includes('inset-0') ||
    (classes.includes('top-0') && classes.includes('bottom-0')) ||
    (classes.includes('h-full') && classes.includes('w-full')) ||
    insetZero ||
    (isZeroLength(box?.top) && isZeroLength(box?.bottom)) ||
    (isFullLength(box?.width) && isFullLength(box?.height))
  );
}

// paintsSomething is a method on Palette; see the class body.
