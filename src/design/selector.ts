/**
 * The part of CSS selector matching that can be decided with certainty from source.
 *
 * `src/parse/css.ts` refuses anything but a single class, id or tag, and the reason it
 * gives is sound: pretending to resolve a cascade you cannot see is how automated
 * accessibility tools end up reporting confident nonsense. But that refusal was drawn one
 * step too tight. `.card .title` is not a guess — the parsed markup has the ancestor
 * chain, so whether an element has an ancestor matching `.card` is a fact, checkable, not
 * inferred.
 *
 * That distinction is the whole rule here: a selector is supported when every part of it
 * can be answered by looking at the element and its ancestors, and rejected when it
 * cannot. So `.card .title`, `nav > a` and `p.lead` are in; `:hover`, `[data-x]`, `*`,
 * `+`, `~` and `:nth-child` are out, because their answers depend on state, on attributes
 * this module does not read, or on sibling order the parser does not track.
 *
 * It matters most on the input this tool grew into: hand-written CSS on an institutional
 * site, where `.footer p { color: #999 }` is the normal way to write things and single-
 * class rules are the exception. Ignoring those does not merely miss findings. A rule
 * that would have *overridden* the one we did apply, ignored, turns a legible page into a
 * finding — so reading more of the cascade is a precision fix as much as a coverage one.
 */

import type { Element } from '../parse/markup.js';
import { getAttr } from '../parse/markup.js';

/** One compound selector: at most a tag, at most an id, any number of classes. */
export interface Compound {
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
}

export type Combinator = 'descendant' | 'child';

export interface ParsedSelector {
  /**
   * Compounds right to left. `steps[0]` is the subject — the element the rule styles —
   * and each later step is an ancestor it must be found under.
   */
  readonly steps: readonly Compound[];
  /** How `steps[i]` relates to `steps[i + 1]`. One shorter than `steps`. */
  readonly combinators: readonly Combinator[];
  /** The a-b-c triple flattened into one comparable number. */
  readonly specificity: number;
  /** Index key for the subject: its id if it has one, else its first class, else its tag. */
  readonly key: string;
}

/** Anything here means the answer depends on something this module cannot see. */
const UNSUPPORTED = /[:[\]*+~,()@|^$="']/;

const COMPOUND = /^(?:[a-zA-Z][\w-]*)?(?:[.#][A-Za-z_][\w-]*)*$/;

function parseCompound(text: string): Compound | null {
  if (text === '' || !COMPOUND.test(text)) return null;
  let tag: string | undefined;
  let id: string | undefined;
  const classes: string[] = [];

  const first = /^[a-zA-Z][\w-]*/.exec(text);
  let rest = text;
  if (first !== null) {
    tag = first[0].toLowerCase();
    rest = text.slice(first[0].length);
  }
  for (const m of rest.matchAll(/([.#])([A-Za-z_][\w-]*)/g)) {
    if (m[1] === '#') {
      // Two ids in one compound can never match anything.
      if (id !== undefined) return null;
      id = m[2] as string;
    } else {
      classes.push(m[2] as string);
    }
  }
  if (tag === undefined && id === undefined && classes.length === 0) return null;
  return { ...(tag !== undefined ? { tag } : {}), ...(id !== undefined ? { id } : {}), classes };
}

/**
 * A selector this module can answer, or null.
 *
 * Null is not a failure to be worked around: it is the honest answer for a selector whose
 * effect cannot be determined, and the caller's job is then to leave the declaration out
 * rather than apply it to something it may not style.
 */
export function parseSelector(selector: string): ParsedSelector | null {
  const s = selector.trim();
  if (s === '' || UNSUPPORTED.test(s)) return null;
  // A leading or trailing combinator is a selector we do not understand rather than one
  // with an empty compound in it.
  if (/^[>]|[>]$/.test(s)) return null;

  // Split into compounds, remembering the combinator that preceded each. Written left to
  // right here and reversed at the end, because that is the order CSS is written in and
  // the order the matcher wants is the other one.
  const tokens = s.split(/\s*>\s*|\s+/).filter((t) => t !== '');
  if (tokens.length === 0 || tokens.length > 8) return null;
  const combinatorsLtr: Combinator[] = [];
  {
    // Re-scan for the combinator characters in order: `a > b c` is child then descendant.
    const between = s.split(/[^\s>]+/).slice(1, tokens.length);
    for (const gap of between) combinatorsLtr.push(gap.includes('>') ? 'child' : 'descendant');
  }
  if (combinatorsLtr.length !== tokens.length - 1) return null;

  const compoundsLtr: Compound[] = [];
  for (const t of tokens) {
    const c = parseCompound(t);
    if (c === null) return null;
    compoundsLtr.push(c);
  }

  const steps = [...compoundsLtr].reverse();
  const combinators = [...combinatorsLtr].reverse();

  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const c of compoundsLtr) {
    if (c.id !== undefined) ids++;
    classes += c.classes.length;
    if (c.tag !== undefined) tags++;
  }

  const subject = steps[0] as Compound;
  const key =
    subject.id !== undefined
      ? `i:${subject.id}`
      : subject.classes.length > 0
        ? `c:${subject.classes[0] as string}`
        : `t:${subject.tag as string}`;

  return {
    steps,
    combinators,
    specificity: ids * 10000 + classes * 100 + tags,
    key,
  };
}

function classesOf(el: Element): readonly string[] {
  const attr = getAttr(el, 'class') ?? getAttr(el, 'className');
  if (attr === undefined || attr.dynamic || attr.value === null) return [];
  return attr.value.split(/\s+/).filter((c) => c !== '');
}

function matchesCompound(el: Element, c: Compound): boolean {
  if (c.tag !== undefined && el.tagLower !== c.tag) return false;
  if (c.id !== undefined) {
    const id = getAttr(el, 'id');
    if (id === undefined || id.dynamic || id.value !== c.id) return false;
  }
  if (c.classes.length > 0) {
    const own = classesOf(el);
    for (const want of c.classes) if (!own.includes(want)) return false;
  }
  return true;
}

/**
 * Does this element match the selector?
 *
 * Descendant steps take the nearest matching ancestor and do not backtrack. For
 * `.a .b .c` with two candidate `.b` ancestors that is theoretically incomplete, and the
 * incompleteness only ever produces a *missed* match — which leaves a declaration
 * unapplied, the same outcome as before this module existed.
 */
export function matchesSelector(el: Element, sel: ParsedSelector): boolean {
  if (!matchesCompound(el, sel.steps[0] as Compound)) return false;

  let node: Element | null = el;
  for (let i = 0; i < sel.combinators.length; i++) {
    const want = sel.steps[i + 1] as Compound;
    node = node.parent;
    if (sel.combinators[i] === 'child') {
      if (node === null || !matchesCompound(node, want)) return false;
    } else {
      while (node !== null && !matchesCompound(node, want)) node = node.parent;
      if (node === null) return false;
    }
  }
  return true;
}
