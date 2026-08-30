/**
 * A tolerant markup tokenizer that keeps exact source offsets.
 *
 * Every accessibility checker on the market parses the *rendered DOM*. That tells you
 * a node is broken but not where it came from, so a human has to find the source and
 * edit it by hand — which is the expensive part of the job. This parser exists to skip
 * that step: it reads the source directly and records, byte for byte, where every tag
 * and attribute begins and ends, so a rule can emit a patch instead of a complaint.
 *
 * It is deliberately not a spec-compliant HTML parser. It never builds a normalised
 * DOM, never reorders attributes, never invents implied elements. Anything it does not
 * understand is left alone, because the worst failure mode for a tool that rewrites
 * source is confidently mangling markup it misread.
 *
 * The same tokenizer handles HTML, JSX/TSX and Vue/Svelte templates. Their differences
 * live in attribute values — {expr}, :bound, @event — so those are recorded with their
 * syntax marked rather than parsed into separate dialects.
 */

export type QuoteKind = '"' | "'" | '{' | null;

export interface Attr {
  /** Attribute name exactly as written (case preserved: JSX is case-sensitive). */
  readonly name: string;
  /** Lowercased name, for matching HTML attributes without care for case. */
  readonly nameLower: string;
  /**
   * Value text with quotes or braces stripped. `null` for a valueless attribute
   * (`disabled`) — distinct from `''`, which is an explicitly empty value (`alt=""`).
   */
  readonly value: string | null;
  readonly nameStart: number;
  readonly nameEnd: number;
  /** Span of the value including its quotes or braces; equals nameEnd when valueless. */
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quote: QuoteKind;
  /** True when the value is a JSX/Vue/Svelte expression rather than a literal. */
  readonly dynamic: boolean;
}

export interface Element {
  readonly tag: string;
  readonly tagLower: string;
  readonly attrs: readonly Attr[];
  /** Offset of '<'. */
  readonly openStart: number;
  /** Offset just past '>' of the opening tag. */
  readonly openEnd: number;
  /** Offset just past the closing tag, or openEnd when self-closing/void/unclosed. */
  readonly end: number;
  readonly selfClosing: boolean;
  readonly depth: number;
  parent: Element | null;
  readonly children: Element[];
  /** Raw source between openEnd and the closing tag. Empty for void elements. */
  readonly innerSource: string;
}

export interface ParsedMarkup {
  readonly source: string;
  /** Every element in document order. */
  readonly elements: readonly Element[];
  /** Top-level elements only. */
  readonly roots: readonly Element[];
}

/** Elements that never have a closing tag in HTML. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is not markup and must not be scanned for tags. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'pre']);

const NAME_START = /[A-Za-z_$]/;
const NAME_CHAR = /[-A-Za-z0-9_:.$]/;

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/**
 * Scan a balanced brace expression starting at `start` (which must be '{').
 * Strings and nested braces are skipped so that `{cond ? "a}b" : {x:1}}` is handled.
 */
function scanBraces(src: string, start: number): number {
  let depth = 0;
  let i = start;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i] as string;
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else {
        if (ch === quote) quote = null;
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

function parseAttributes(src: string, from: number, limit: number): { attrs: Attr[]; end: number } {
  const attrs: Attr[] = [];
  let i = from;

  while (i < limit) {
    while (i < limit && isSpace(src[i])) i++;
    if (i >= limit) break;
    const ch = src[i] as string;
    if (ch === '>' || (ch === '/' && src[i + 1] === '>')) break;

    // A bare JSX spread ({...props}) carries no name; skip it without losing our place.
    if (ch === '{') {
      i = scanBraces(src, i);
      continue;
    }
    if (!NAME_START.test(ch) && ch !== '@' && ch !== ':' && ch !== '#') {
      i++;
      continue;
    }

    const nameStart = i;
    if (ch === '@' || ch === ':' || ch === '#') i++;
    while (i < limit && NAME_CHAR.test(src[i] as string)) i++;
    const nameEnd = i;
    const name = src.slice(nameStart, nameEnd);

    let j = i;
    while (j < limit && isSpace(src[j])) j++;
    if (src[j] !== '=') {
      attrs.push({
        name,
        nameLower: name.toLowerCase(),
        value: null,
        nameStart,
        nameEnd,
        valueStart: nameEnd,
        valueEnd: nameEnd,
        quote: null,
        dynamic: false,
      });
      i = nameEnd;
      continue;
    }
    j++; // consume '='
    while (j < limit && isSpace(src[j])) j++;

    const valueStart = j;
    const q = src[j];
    let valueEnd: number;
    let value: string;
    let quote: QuoteKind;
    let dynamic = false;

    if (q === '"' || q === "'") {
      const close = src.indexOf(q, j + 1);
      valueEnd = close < 0 ? limit : close + 1;
      value = src.slice(j + 1, valueEnd - 1);
      quote = q;
      // A quoted value that is itself a template/expression (Vue :prop="x", Svelte).
      dynamic = name.startsWith(':') || name.startsWith('@') || name.startsWith('v-');
    } else if (q === '{') {
      valueEnd = scanBraces(src, j);
      value = src.slice(j + 1, Math.max(j + 1, valueEnd - 1));
      quote = '{';
      dynamic = true;
    } else {
      let k = j;
      while (k < limit && !isSpace(src[k]) && src[k] !== '>' && !(src[k] === '/' && src[k + 1] === '>')) k++;
      valueEnd = k;
      value = src.slice(j, k);
      quote = null;
    }

    attrs.push({
      name,
      nameLower: name.toLowerCase(),
      value,
      nameStart,
      nameEnd,
      valueStart,
      valueEnd,
      quote,
      dynamic,
    });
    i = valueEnd;
  }

  return { attrs, end: i };
}

/** Find the matching close tag for `tag` starting at `from`, honouring nesting. */
function findCloseTag(src: string, tag: string, from: number): { contentEnd: number; end: number } | null {
  const lower = tag.toLowerCase();
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) return null;
    if (src[lt + 1] === '/') {
      let k = lt + 2;
      while (k < src.length && NAME_CHAR.test(src[k] as string)) k++;
      if (src.slice(lt + 2, k).toLowerCase() === lower) {
        depth--;
        const gt = src.indexOf('>', k);
        if (depth === 0) return { contentEnd: lt, end: gt < 0 ? src.length : gt + 1 };
        i = gt < 0 ? src.length : gt + 1;
        continue;
      }
      i = lt + 2;
      continue;
    }
    let k = lt + 1;
    if (k < src.length && NAME_START.test(src[k] as string)) {
      while (k < src.length && NAME_CHAR.test(src[k] as string)) k++;
      if (src.slice(lt + 1, k).toLowerCase() === lower) {
        // Nested same-tag open: only counts if it is not self-closing.
        const gt = src.indexOf('>', k);
        if (gt > 0 && src[gt - 1] !== '/') depth++;
        i = gt < 0 ? src.length : gt + 1;
        continue;
      }
    }
    i = lt + 1;
  }
  return null;
}

/** Parse markup, preserving every source offset. Never throws on malformed input. */
export interface ParseOptions {
  /**
   * Ignore markup written inside a JavaScript template literal.
   *
   * Documentation sites, code-example pages and test fixtures are full of
   * `const code = dedent\`<html>…\`` — real markup as far as a tokeniser is concerned,
   * and not part of the page at all. On one documentation site every single
   * "document has no lang" finding came from a snippet of exactly that shape.
   *
   * Literals tagged `html` are kept, because in lit-html that is the page.
   */
  readonly skipTemplateLiterals?: boolean;
}

export function parseMarkup(source: string, options: ParseOptions = {}): ParsedMarkup {
  const elements: Element[] = [];
  const roots: Element[] = [];
  const stack: Element[] = [];
  const masked = options.skipTemplateLiterals === true ? templateLiteralRanges(source) : [];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;

    const skipTo = maskedEnd(masked, lt);
    if (skipTo >= 0) {
      i = skipTo;
      continue;
    }

    // Comments and doctype/CDATA carry no attributes; skip them whole.
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      i = close < 0 ? source.length : close + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const gt = source.indexOf('>', lt);
      i = gt < 0 ? source.length : gt + 1;
      continue;
    }
    if (source[lt + 1] === '/') {
      let k = lt + 2;
      while (k < source.length && NAME_CHAR.test(source[k] as string)) k++;
      const closing = source.slice(lt + 2, k).toLowerCase();
      const gt = source.indexOf('>', k);
      // Pop to the matching open element if we have one.
      for (let s = stack.length - 1; s >= 0; s--) {
        if ((stack[s] as Element).tagLower === closing) {
          stack.length = s;
          break;
        }
      }
      i = gt < 0 ? source.length : gt + 1;
      continue;
    }

    const nameStart = lt + 1;
    if (nameStart >= source.length || !NAME_START.test(source[nameStart] as string)) {
      i = lt + 1;
      continue;
    }
    let k = nameStart;
    while (k < source.length && NAME_CHAR.test(source[k] as string)) k++;
    const tag = source.slice(nameStart, k);
    const tagLower = tag.toLowerCase();

    // Bound attribute scanning to this tag so a stray '<' in text cannot run away.
    const searchLimit = Math.min(source.length, k + 20000);
    const { attrs, end: afterAttrs } = parseAttributes(source, k, searchLimit);

    let p = afterAttrs;
    while (p < source.length && isSpace(source[p])) p++;
    let selfClosing = false;
    if (source[p] === '/' && source[p + 1] === '>') {
      selfClosing = true;
      p += 2;
    } else if (source[p] === '>') {
      p += 1;
    } else {
      const gt = source.indexOf('>', afterAttrs);
      p = gt < 0 ? source.length : gt + 1;
      selfClosing = gt > 0 && source[gt - 1] === '/';
    }
    const openEnd = p;

    const isVoid = VOID_ELEMENTS.has(tagLower);
    let end = openEnd;
    let innerSource = '';

    if (!selfClosing && !isVoid) {
      if (RAW_TEXT_ELEMENTS.has(tagLower)) {
        // Raw-text content must not be scanned for tags, or a '<' inside a script
        // string would open a phantom element.
        const closeIdx = source.toLowerCase().indexOf(`</${tagLower}`, openEnd);
        if (closeIdx >= 0) {
          innerSource = source.slice(openEnd, closeIdx);
          const gt = source.indexOf('>', closeIdx);
          end = gt < 0 ? source.length : gt + 1;
        } else {
          end = source.length;
          innerSource = source.slice(openEnd);
        }
      } else {
        const close = findCloseTag(source, tagLower, openEnd);
        if (close !== null) {
          innerSource = source.slice(openEnd, close.contentEnd);
          end = close.end;
        }
      }
    }

    const parent = stack.length > 0 ? (stack[stack.length - 1] as Element) : null;
    const el: Element = {
      tag,
      tagLower,
      attrs,
      openStart: lt,
      openEnd,
      end,
      selfClosing: selfClosing || isVoid,
      depth: stack.length,
      parent,
      children: [],
      innerSource,
    };
    elements.push(el);
    if (parent !== null) parent.children.push(el);
    else roots.push(el);

    if (RAW_TEXT_ELEMENTS.has(tagLower)) {
      // Content already consumed; do not descend into it.
      i = end;
      continue;
    }
    if (!el.selfClosing && end > openEnd) stack.push(el);
    i = openEnd;
  }

  return { source, elements, roots };
}

/** Look up an attribute by name, case-insensitively. */
export function getAttr(el: Element, name: string): Attr | undefined {
  const lower = name.toLowerCase();
  return el.attrs.find((a) => a.nameLower === lower);
}

export function hasAttr(el: Element, name: string): boolean {
  return getAttr(el, name) !== undefined;
}

/**
 * Visible text inside an element, with tags and expressions removed.
 * Used to decide whether a control has an accessible name from its own content.
 */
export function textOf(el: Element): string {
  return el.innerSource
    // Script and style bodies are not visible text; leaving them in would let a
    // stylesheet or a click handler masquerade as an element's accessible name.
    .replace(new RegExp("<(script|style)\\b[^>]*>[\\s\\S]*?</\\1>", 'gi'), ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 1-indexed line and column for an offset. */
export function positionAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return { line, column: offset - last + 1 };
}

/**
 * Byte ranges covered by untagged (or non-html-tagged) template literals.
 *
 * Hand-rolled rather than delegated to a JavaScript parser: this runs on every file in a
 * scan, the tool has no dependencies by design, and the only thing that has to be exactly
 * right is where a literal ends. Escapes and \${…} interpolation — which can itself
 * contain nested literals — are tracked; everything else is deliberately ignored.
 */
function templateLiteralRanges(source: string): (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < source.length) {
    const tick = source.indexOf('`', i);
    if (tick < 0) break;
    // An escaped backtick is not an opener.
    if (tick > 0 && countPrecedingBackslashes(source, tick) % 2 === 1) {
      i = tick + 1;
      continue;
    }
    const tag = tagBefore(source, tick);
    const end = skipTemplate(source, tick);
    // lit-html's html`…` really is markup, so it is left visible.
    if (tag !== 'html') ranges.push([tick, end]);
    i = end;
  }
  return ranges;
}

function countPrecedingBackslashes(source: string, at: number): number {
  let n = 0;
  let j = at - 1;
  while (j >= 0 && source[j] === '\\') {
    n++;
    j--;
  }
  return n;
}

/** The tag function immediately before a backtick, if any: `dedent`, `css`, `html`. */
function tagBefore(source: string, tick: number): string {
  let j = tick - 1;
  while (j >= 0 && NAME_CHAR.test(source[j] as string)) j--;
  return source.slice(j + 1, tick);
}

/** Index just past the closing backtick of the template literal opening at `start`. */
function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && source[i + 1] === '{') {
      i = skipInterpolation(source, i + 2);
      continue;
    }
    i++;
  }
  return source.length;
}

/** Index just past the `}` closing a \${…} interpolation, honouring nesting. */
function skipInterpolation(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return i;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    // An unterminated string must not swallow the rest of the file.
    if (ch === '\n') return i;
    i++;
  }
  return i;
}

/** End of the masked range containing `at`, or -1 when it is not masked. */
function maskedEnd(ranges: readonly (readonly [number, number])[], at: number): number {
  for (const [start, end] of ranges) {
    if (at < start) return -1;
    if (at < end) return end;
  }
  return -1;
}
