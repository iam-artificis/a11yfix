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
 *
 * Returns the offset just past the closing brace, or `-1` when the expression could not
 * be read to its end.
 *
 * The sentinel matters more than the scanning. This function used to return
 * `src.length` when the braces never balanced, which reads as "the expression runs to
 * the end of the file" — and every caller believed it. A JSX attribute containing an
 * ordinary apostrophe in a comment,
 *
 *     onClick={() => {
 *       // don't submit twice
 *       submit();
 *     }}
 *
 * left the scanner inside a string it never left, so the element's opening tag was
 * recorded as reaching the last character of the module. The rules then inserted
 * `role="button"` at `openEnd - 1`, which is the file's final `}`, and `--fix` wrote a
 * file that no longer parses. Every element nested inside the swallowed span went
 * unreported at the same time.
 *
 * So: comments and regex literals are understood, a single- or double-quoted string
 * cannot span a line, and anything still unbalanced at the end is reported as a failure
 * rather than as a very long expression.
 */
function scanBraces(src: string, start: number): number {
  return scanBalanced(src, start, 0, 0);
}

/**
 * How deep template literals and interpolations may nest before we give up.
 *
 * A real file does not reach five. The cap exists so that a pathological or truncated
 * input cannot recurse until the stack overflows and takes the whole scan with it —
 * losing every finding in every remaining file, not just this one. Refusing to read one
 * expression is the same answer the rest of the parser gives when it cannot be sure.
 */
const MAX_NESTING = 32;

/**
 * Read JavaScript until the brace depth returns to zero.
 *
 * `depth` is 0 when `start` points at the opening `{`, and 1 when it points just past a
 * `${`. Both are the same problem, and they used to be two functions: `scanBraces`
 * treated a backtick as an ordinary quote with no notion of `${…}` inside it, while
 * `skipInterpolation` understood templates but not comments. So this,
 *
 *     value={`<div style="width:${getDimension(w)};height:${getDimension(
 *       h
 *     )};overflow:scroll"></div>`}
 *
 * ended the attribute at the `}` of the second interpolation, the tag ended at the `>`
 * of `</div>`, and the element was recorded as running to the end of the file. Every
 * element in the 280 lines after it went unreported — including an `<iframe>` with no
 * title, which is the finding that vanished from cal.com without anyone noticing.
 *
 * Returns the offset just past the closing brace, or -1 when it could not be read.
 */
function scanBalanced(src: string, start: number, depth: number, nesting: number): number {
  if (nesting > MAX_NESTING) return -1;
  let i = start;

  while (i < src.length) {
    const ch = src[i] as string;

    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    if (ch === '/' && startsRegex(src, i)) {
      const end = scanRegex(src, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }

    if (ch === '`') {
      const end = skipTemplate(src, i, nesting + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A ' or " string cannot span a line. Without that rule a lone apostrophe leaves
      // the scanner quoted for the rest of the file.
      i = skipQuoted(src, i, ch);
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }

  // Unbalanced: say we could not read it rather than claiming it reaches the end.
  return -1;
}

/**
 * Whether the '/' at `i` opens a regex literal rather than being division or JSX.
 *
 * An allowlist, not a denylist. A regex can only begin where a value is expected, and the
 * things a value can follow are few enough to list: an operator, a comma, an opening
 * bracket, or one of a handful of keywords. Everything else — a closing quote, a closing
 * bracket, an identifier, a digit — means division.
 *
 * The denylist version of this got `target="_blank" />` wrong: the character before the
 * slash is a quote, which is not an identifier, so it read as a value position and the
 * scanner went looking for the end of a regex that was really a self-closing tag. Every
 * JSX element passed through an attribute expression (`render={<a ... />}`) then failed
 * to parse, and the tags around it were reported as unreadable.
 */
function startsRegex(src: string, i: number): boolean {
  // Never inside JSX punctuation: '/>' closes a tag and '</' opens a closing one.
  if (src[i + 1] === '>') return false;
  let j = i - 1;
  while (j >= 0 && isSpace(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j] as string;
  if (prev === '<') return false;
  if (VALUE_POSITION.has(prev)) return true;
  // `return /x/` and `typeof /x/` are patterns despite ending in a letter.
  const word = /[A-Za-z0-9_$]+$/.exec(src.slice(Math.max(0, j - 12), j + 1));
  return word !== null && KEYWORDS_BEFORE_REGEX.has(word[0]);
}

/** Characters after which a value — and so a regex literal — may begin. */
const VALUE_POSITION = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^',
]);

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await',
]);

/** End of the regex literal starting at `start`, or -1 if it is unterminated. */
function scanRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    // An unterminated regex cannot cross a line, so a newline means we misread it.
    if (ch === '\n') return -1;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i] as string)) i++;
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Read a tag's attributes.
 *
 * `window` bounds how far we look for the *next* attribute, so an unterminated tag in
 * malformed input cannot make the scan run to the end of the file. It is deliberately not
 * a hard cut on the tag: a single value can be longer than the whole window — a 20 KB
 * base64 `data:` URI is enough — and stopping mid-tag returns a truncated attribute list
 * with no signal that anything is missing. A rule then reports an attribute that is right
 * there in the source as absent, and `--fix` writes a duplicate next to it. In JSX a
 * duplicate prop is a type error, and under Babel the later one wins, so a correct
 * `lang="en"` was being overridden with `lang=""`.
 *
 * So the window slides forward past any value that ended on its own terminator, and only
 * genuinely unterminated input stops the scan.
 */
function parseAttributes(src: string, from: number, window: number): { attrs: Attr[]; end: number } {
  const attrs: Attr[] = [];
  let limit = Math.min(src.length, from + window);
  let i = from;

  while (i < limit) {
    while (i < limit && isSpace(src[i])) i++;
    if (i >= limit) break;
    const ch = src[i] as string;
    if (ch === '>' || (ch === '/' && src[i + 1] === '>')) break;

    // A bare JSX spread ({...props}) carries no name; skip it without losing our place.
    if (ch === '{') {
      const next = scanBraces(src, i);
      if (next < 0) return { attrs, end: -1 };
      i = next;
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
    // Whether the value ended on its own closing delimiter rather than on the window.
    // Only a well-formed value earns more window.
    let terminated = true;

    if (q === '"' || q === "'") {
      const close = src.indexOf(q, j + 1);
      terminated = close >= 0;
      valueEnd = close < 0 ? limit : close + 1;
      value = src.slice(j + 1, valueEnd - 1);
      quote = q;
      // A quoted value that is itself a template/expression (Vue :prop="x", Svelte).
      dynamic = name.startsWith(':') || name.startsWith('@') || name.startsWith('v-');
    } else if (q === '{') {
      valueEnd = scanBraces(src, j);
      if (valueEnd < 0) return { attrs, end: -1 };
      value = src.slice(j + 1, Math.max(j + 1, valueEnd - 1));
      quote = '{';
      dynamic = true;
    } else {
      // An unquoted value ends at whitespace, '>' or end of input on its own, so it needs
      // no window: bounding it here would slice a long one short for no benefit.
      let k = j;
      while (k < src.length && !isSpace(src[k]) && src[k] !== '>' && !(src[k] === '/' && src[k + 1] === '>')) k++;
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
    // A single value can be longer than the whole window. Since it ended on its own
    // delimiter the tag is still well formed, so slide the window forward rather than
    // dropping every attribute that comes after it.
    if (i >= limit && terminated) limit = Math.min(src.length, i + window);
  }

  return { attrs, end: i };
}

/**
 * The result of looking for a close tag.
 *
 * `sawClose` is the part that matters for speed: when the scan reached the end of the
 * file without meeting a single `</tag`, no later element of that name will find one
 * either, so the caller can stop asking. Without that, a list of a few thousand `<li>`
 * written without closing tags — which is legal HTML and common in generated pages —
 * made every item scan to the end of the document looking for a `</li>` that is not
 * there. 4000 items took 425ms in the tokeniser alone.
 *
 * It has to be `sawClose` rather than "this position failed", because a same-name tag
 * nested inside raises the depth: in `<p><p></p>` the outer `<p>` finds no close and the
 * inner one does, so a failure at an earlier offset says nothing about a later one.
 */
interface CloseSearch {
  readonly found: { contentEnd: number; end: number } | null;
  readonly sawClose: boolean;
}

/** Find the matching close tag for `tag` starting at `from`, honouring nesting. */
function findCloseTag(src: string, tag: string, from: number): CloseSearch {
  const lower = tag.toLowerCase();
  let depth = 1;
  let sawClose = false;
  let i = from;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) return { found: null, sawClose };
    if (src[lt + 1] === '/') {
      let k = lt + 2;
      while (k < src.length && NAME_CHAR.test(src[k] as string)) k++;
      if (src.slice(lt + 2, k).toLowerCase() === lower) {
        sawClose = true;
        depth--;
        const gt = src.indexOf('>', k);
        if (depth === 0) {
          return { found: { contentEnd: lt, end: gt < 0 ? src.length : gt + 1 }, sawClose };
        }
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
  return { found: null, sawClose };
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
  // Tag names with no closing tag left in the document. See CloseSearch.
  const unclosedTags = new Set<string>();
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
    const { attrs, end: afterAttrs } = parseAttributes(source, k, 20000);

    // An opening tag we could not read to its end is skipped entirely: no element is
    // recorded, so no rule can compute an insertion point inside a span whose extent we
    // do not know. Scanning resumes just after the '<', so anything nested inside is
    // still found. A missed finding is the correct failure here; a patch written at a
    // guessed offset is not.
    if (afterAttrs < 0) {
      i = lt + 1;
      continue;
    }

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
        const closeIdx = indexOfCloseTag(source, tagLower, openEnd);
        if (closeIdx >= 0) {
          innerSource = source.slice(openEnd, closeIdx);
          const gt = source.indexOf('>', closeIdx);
          end = gt < 0 ? source.length : gt + 1;
        } else {
          end = source.length;
          innerSource = source.slice(openEnd);
        }
      } else if (!unclosedTags.has(tagLower)) {
        const close = findCloseTag(source, tagLower, openEnd);
        if (close.found !== null) {
          innerSource = source.slice(openEnd, close.found.contentEnd);
          end = close.found.end;
        } else if (!close.sawClose) {
          // There is no </tag anywhere ahead, so no later element of this name needs to
          // go looking for one.
          unclosedTags.add(tagLower);
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
  return (
    decodeReferences(
      el.innerSource
        // Script and style bodies are not visible text; leaving them in would let a
        // stylesheet or a click handler masquerade as an element's accessible name.
        .replace(new RegExp("<(script|style)\\b[^>]*>[\\s\\S]*?</\\1>", 'gi'), ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{[^}]*\}/g, ' '),
      // Decoded after the tags come out, never before: `&lt;div&gt;` would otherwise
      // become `<div>` and be stripped as markup the author never wrote.
    )
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Named character references, decoded rather than blanked.
 *
 * `textOf` used to replace `&[a-z]+;` with a space, which makes two spellings of one
 * character disagree about whether an element has any text: `<button>&times;</button>`
 * was reported as having none while `<button>×</button>` and `<button>&#215;</button>`
 * were fine. obrnadzor.gov.ru serves `<button class="swipe-btn prev">&lt;</button>`, and
 * because the excerpt is cut at the opening tag the report printed the tag and never
 * showed the `&lt;` that contradicts the sentence beneath it.
 *
 * Whitespace references are decoded to real whitespace rather than being special-cased,
 * and that preserves every behaviour the old blanking gave us: JavaScript's `\s` and
 * `String.prototype.trim` both treat U+00A0 as whitespace, so a button holding nothing
 * but `&nbsp;` still comes out empty — which is what shm.ru's forty-odd unnamed close
 * buttons depend on.
 *
 * A reference this table does not know is left exactly as written. That errs toward
 * "this element has text", which is the direction that stays quiet rather than the one
 * that invents a finding.
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad',
  zwj: '\u200d', zwnj: '\u200c',
  mdash: '—', ndash: '–', minus: '−', horbar: '―',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bdquo: '„',
  hellip: '…', middot: '·', bull: '•', sect: '§', para: '¶',
  dagger: '†', Dagger: '‡', prime: '′', Prime: '″',
  times: '×', divide: '÷', deg: '°', plusmn: '±',
  ne: '≠', le: '≤', ge: '≥', infin: '∞',
  copy: '©', reg: '®', trade: '™',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  crarr: '↵', lArr: '⇐', rArr: '⇒',
  sup1: '¹', sup2: '²', sup3: '³',
  frac12: '½', frac14: '¼', frac34: '¾',
  iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª',
  szlig: 'ß', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', aring: 'å',
  aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê',
  igrave: 'ì', iacute: 'í', ntilde: 'ñ', ograve: 'ò', oacute: 'ó',
  oslash: 'ø', ugrave: 'ù', uacute: 'ú', yacute: 'ý',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π',
  sigma: 'σ', omega: 'ω', mu: 'µ',
};

/** Highest code point Unicode defines; anything past it is not a character. */
const MAX_CODE_POINT = 0x10ffff;

/** Decode numeric and known named character references, leaving anything else alone. */
export function decodeReferences(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 0x23) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // A lone surrogate is not a character and would put a broken one in a report line.
      if (!Number.isFinite(cp) || cp <= 0 || cp > MAX_CODE_POINT) return whole;
      if (cp >= 0xd800 && cp <= 0xdfff) return whole;
      return String.fromCodePoint(cp);
    }
    return NAMED_REFERENCES[body] ?? NAMED_REFERENCES[body.toLowerCase()] ?? whole;
  });
}

/** 1-indexed line and column for an offset. */
/**
 * Line starts for the file being scanned, remembered between calls.
 *
 * One entry, because a scan works through one file at a time and the next file evicts
 * the last. The memo is pure — same source, same answer — so it changes speed and
 * nothing else; and it is bounded, holding one file's worth of offsets rather than
 * accumulating an index per file scanned.
 *
 * Without it every violation counted newlines from byte 0 again. A file reporting 1600
 * findings walked its own bytes 1600 times, which is quadratic in exactly the case a
 * first run on a neglected codebase produces.
 */
let lineIndexSource: string | null = null;
let lineIndexStarts: readonly number[] = [0];

function lineStarts(source: string): readonly number[] {
  if (source === lineIndexSource) return lineIndexStarts;
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  lineIndexSource = source;
  lineIndexStarts = starts;
  return starts;
}

export function positionAt(source: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(source);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] as number) + 1 };
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
    if (end < 0) {
      // No closing backtick anywhere. A file that compiles cannot contain an unterminated
      // template literal, so this backtick is prose — "Press ` to jump here" inside a
      // paragraph, most often. Masking from here to the end of the file blanked out the
      // rest of the component: a <label> after it stopped being seen, so its input was
      // reported as unlabelled, and every real finding past the backtick disappeared
      // without a word. One stray character produced a fabricated error and a silent
      // blackout at the same time.
      i = tick + 1;
      continue;
    }
    // lit-html's html`…` really is markup, so it is left visible.
    if (tag !== 'html') ranges.push([tick, end]);
    i = end;
  }
  return ranges;
}

/**
 * Where `</tag` next appears, matched without regard to case and without copying.
 *
 * `source.toLowerCase().indexOf(…)` allocated a second copy of the whole file for every
 * <script>, <style>, <textarea>, <title> and <pre> in it. A page with a hundred of them
 * lowercased a hundred copies of the file to find a hundred short strings.
 */
function indexOfCloseTag(source: string, tagLower: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) return -1;
    const nameEnd = lt + 2 + tagLower.length;
    if (source[lt + 1] === '/' && source.slice(lt + 2, nameEnd).toLowerCase() === tagLower) {
      return lt;
    }
    i = lt + 1;
  }
  return -1;
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

/** Index just past the closing backtick, or -1 when the literal is never closed. */
function skipTemplate(source: string, start: number, nesting = 0): number {
  if (nesting > MAX_NESTING) return -1;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && source[i + 1] === '{') {
      // A failure here has to travel. Assigning -1 to `i` restarted the scan from index
      // 0 with the depth counter still raised, which is not so much a wrong answer as a
      // different file.
      const end = scanBalanced(source, i + 2, 1, nesting + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    i++;
  }
  // Never closed. Returning source.length would say "this literal runs to the end of the
  // file", and the caller would then mask everything after it.
  return -1;
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
