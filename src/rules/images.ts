import type { Edit, Fix, Rule, RuleContext, Violation } from '../types.js';
import type { Attr, Element } from '../parse/markup.js';
import { textOf } from '../parse/markup.js';

/**
 * Images and media alternatives — the family where refusing to act is the feature.
 *
 * Every other checker can tell you an `<img>` has no `alt`. The temptation, once you
 * hold the source and can write to it, is to fill the gap: derive something from the
 * file name, from a nearby heading, from a model. Do not. Alt text is a claim about
 * what a picture *means to this page*, and nothing in the source carries that. A wrong
 * alt is strictly worse than a missing one — the missing one is announced as a problem
 * by the screen reader itself and reported by every auditor downstream, while the wrong
 * one silently misinforms the reader and marks the page green forever.
 *
 * So the rules here split cleanly along one line:
 *
 *  - anything that requires knowing what an image *shows* is `manual`, carries an
 *    advisory, and emits no edit at all;
 *  - anything that is pure redundancy or pure mechanism — a doubled "image of" prefix,
 *    a missing `focusable="false"` on an already-hidden icon — is patched, because
 *    deleting a duplicate word and disabling a legacy tab stop invent no meaning.
 *
 * Even the second group is `review`, never `automatic`: nothing in this family is so
 * certain that it should be written into someone's repository without a human reading
 * the diff. Every edit is additionally gated on `openTagIsIntact` / `attrSpanIsSafe`,
 * because a tolerant tokenizer hands back plausible offsets for malformed markup and an
 * edit against those offsets deletes code that was merely untidy before we arrived.
 *
 * `fixAllowed()` refuses any fix that carries an advisory, so a fix here either has
 * edits or has an advisory, never both.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Find an attribute under any of the dialect spellings that bind the same name:
 * `alt`, Vue's `:alt` / `v-bind:alt`, Alpine's `x-bind:alt`. JSX's `alt={expr}` is
 * already a plain attribute with `quote === '{'`.
 *
 * This matters for correctness, not tidiness: `<img :alt="caption">` has an alt, and a
 * rule that only looked for the literal name would file a violation against working
 * code — the fastest way to get a linter deleted from a project.
 */
function findNamed(el: Element, name: string): Attr | undefined {
  const lower = name.toLowerCase();
  for (const a of el.attrs) {
    const n = a.nameLower;
    if (n === lower || n === ':' + lower || n === 'v-bind:' + lower || n === 'x-bind:' + lower) {
      return a;
    }
  }
  return undefined;
}

/**
 * Attribute names that bind an *expression* in one of the template dialects.
 *
 * The tokenizer flags `:alt="x"` and `v-bind:alt="x"` as dynamic, but it has no rule for
 * Alpine: `x-bind:alt="caption"` arrives as an ordinary double-quoted attribute with
 * `dynamic === false`. A rule that trusted `Attr.dynamic` alone would rewrite the
 * expression `caption` as the literal string "caption", or delete a live binding whose
 * behaviour it never saw. `findNamed` deliberately matches those spellings, so the
 * expression test has to recognise them too.
 */
const BOUND_NAME = /^(?:[:@#]|v-|x-bind:|x-on:|x-model|bind:|on:)/;

/** True when the value is an expression rather than literal text we may rewrite. */
function isExpression(a: Attr): boolean {
  return a.dynamic || a.quote === '{' || BOUND_NAME.test(a.nameLower);
}

/** Literal text of an attribute; null when absent, valueless, or an expression. */
function literal(el: Element, name: string): string | null {
  const a = findNamed(el, name);
  if (a === undefined || isExpression(a) || a.value === null) return null;
  return a.value;
}

/**
 * Does this attribute plausibly supply an accessible name? An expression is assumed to
 * produce text, because assuming otherwise means reporting a violation we cannot prove.
 */
function namesElement(el: Element, name: string): boolean {
  const a = findNamed(el, name);
  if (a === undefined) return false;
  if (isExpression(a)) return true;
  return a.value !== null && a.value.trim() !== '';
}

/** `aria-label` or `aria-labelledby` gives the element a name without `alt`. */
function hasAriaName(el: Element): boolean {
  return namesElement(el, 'aria-label') || namesElement(el, 'aria-labelledby');
}

/**
 * A JSX component, not an HTML element. `<Image />` may require `alt`, forbid it, or
 * spell it `altText`; we cannot see its prop contract, so we say nothing about it.
 * Lowercase `<img>` inside JSX is ordinary HTML and is checked normally.
 */
function isCustomComponent(el: Element): boolean {
  const first = el.tag.charAt(0);
  return (first >= 'A' && first <= 'Z') || el.tag.includes('.');
}

const JSX_SPREAD = /\{\s*\.\.\./;

/**
 * The opening tag may receive attributes we cannot enumerate: a JSX spread, a Vue
 * `v-bind="obj"`. Either can carry the very attribute we are about to call missing.
 */
function hasUnknownProps(ctx: RuleContext, el: Element): boolean {
  if (JSX_SPREAD.test(ctx.source.slice(el.openStart, el.openEnd))) return true;
  if (el.attrs.some((a) => a.nameLower === 'v-bind' || a.nameLower === 'x-bind')) return true;
  // A brace group inside the opening tag that belongs to no attribute value is either a
  // spread or a Svelte shorthand (`<img src={s} {alt}>`), and the tokenizer records
  // neither as an attribute. Both can carry the attribute we are about to call missing.
  for (let i = el.openStart + 1; i < el.openEnd; i++) {
    if (ctx.source[i] !== '{') continue;
    if (!el.attrs.some((a) => i >= a.valueStart && i < a.valueEnd)) return true;
  }
  return false;
}

/**
 * The author has already declared this element non-content: hidden from the
 * accessibility tree, or explicitly presentational. Such an element needs no text
 * alternative, and demanding one produces noise that trains people to ignore the tool.
 *
 * Expression-valued `role` / `aria-hidden` count as "possibly decorative" for the same
 * reason: we cannot evaluate them, so we do not assert a failure.
 */
function isDeclaredDecorative(el: Element): boolean {
  const hidden = findNamed(el, 'aria-hidden');
  if (hidden !== undefined) {
    if (isExpression(hidden)) return true;
    if ((hidden.value ?? 'true').trim().toLowerCase() === 'true') return true;
  }
  const role = findNamed(el, 'role');
  if (role !== undefined) {
    if (isExpression(role)) return true;
    const r = (role.value ?? '').trim().toLowerCase();
    if (r === 'presentation' || r === 'none') return true;
  }
  return false;
}

/** Everything legal between the last attribute and the end of an opening tag. */
const TAG_TAIL = /^\s*\/?>$/;

/**
 * Can we prove the opening tag ends where the parser says it does?
 *
 * The proof matters, and it is a precondition for *every* edit in this file, not just
 * for inserting an attribute. Given an unterminated `<svg aria-hidden="true"`, the
 * tokenizer scans forward for the next `>` in the file and finds one belonging to a
 * *later* element, so `openEnd` points into someone else's tag; given an unterminated
 * quote, `<img alt="oops>` closes its value on a quote belonging to a later element and
 * `alt.valueEnd` lands hundreds of bytes downstream. Either way, an offset we trust
 * blindly turns a merely malformed file into a mangled one.
 *
 * Requiring the span after the final attribute to be nothing but whitespace, an optional
 * slash and the closing bracket rules the first case out, and still accepts a JSX
 * expression attribute containing `<`.
 */
function openTagIsIntact(ctx: RuleContext, el: Element): boolean {
  if (ctx.source[el.openEnd - 1] !== '>') return false;
  const last = el.attrs[el.attrs.length - 1];
  const afterAttrs = last === undefined ? el.openStart + 1 + el.tag.length : last.valueEnd;
  if (afterAttrs > el.openEnd) return false;
  if (!TAG_TAIL.test(ctx.source.slice(afterAttrs, el.openEnd))) return false;

  // A runaway tag also absorbs the *attributes* of the element it swallowed, so its tail
  // looks perfectly well formed. The tell is a '<' inside the opening tag that is not
  // part of an attribute value — legal in `{a < b}`, never legal anywhere else.
  for (let i = el.openStart + 1; i < el.openEnd; i++) {
    if (ctx.source[i] !== '<') continue;
    if (!el.attrs.some((a) => i >= a.valueStart && i < a.valueEnd)) return false;
  }
  return true;
}

/**
 * Offset at which a new attribute may be inserted, or null when the opening tag cannot
 * be trusted.
 *
 * HTML void elements (`<img src=x>`) are reported as `selfClosing` but carry no slash,
 * so the byte before `>` is tested rather than the flag: `<svg ... />` inserts before the
 * slash, `<svg ...>` before the bracket.
 */
function attributeInsertPoint(ctx: RuleContext, el: Element): number | null {
  if (!openTagIsIntact(ctx, el)) return null;
  const hasSlash = el.openEnd >= 2 && ctx.source[el.openEnd - 2] === '/';
  return el.openEnd - (hasSlash ? 2 : 1);
}

/**
 * May we rewrite or delete the span this attribute claims to occupy?
 *
 * `Attr.valueEnd` is only as trustworthy as the quote that terminated it. When the
 * closing quote is missing the tokenizer silently closes the value on the next quote in
 * the *file*, so the recorded span covers whatever markup lies between — and an edit
 * against it deletes real code. Three cheap proofs, all of which a well-formed
 * attribute passes: the tag itself is intact, the span lies inside that tag, and the
 * literal contains no angle bracket (which in practice means it swallowed a tag; a
 * genuine `alt="a > b"` merely loses its automatic fix, which costs nothing).
 */
function attrSpanIsSafe(ctx: RuleContext, el: Element, a: Attr): boolean {
  if (!openTagIsIntact(ctx, el)) return false;
  if (a.nameStart < el.openStart || a.valueEnd > el.openEnd) return false;
  if (a.quote === '"' || a.quote === "'") {
    if (a.valueEnd - a.valueStart < 2) return false;
    if (ctx.source[a.valueStart] !== a.quote || ctx.source[a.valueEnd - 1] !== a.quote) return false;
  }
  if (a.value !== null && (a.value.includes('<') || a.value.includes('>'))) return false;
  return true;
}

/**
 * Quote an attribute value for insertion.
 *
 * `JSON.stringify` is the obvious choice and it is wrong here: it escapes an embedded
 * double quote as `\"`, which HTML and JSX both read as a quote that *ends* the value.
 * Values reach us as raw source, so entities in them are already correct.
 */
function quoteAttrValue(value: string): string {
  if (!value.includes('"')) return '"' + value + '"';
  if (!value.includes("'")) return "'" + value + "'";
  return '"' + value.replace(/"/g, '&quot;') + '"';
}

/**
 * Delete an attribute along with the whitespace separating it from the one before.
 *
 * The whole run goes, not a single space: attributes are often written one per line, and
 * eating just one character of a `"\n      "` indent leaves a line of orphaned spaces in
 * the middle of the tag. Whitespace between attributes is insignificant, and whatever
 * followed the attribute — another separator, `/`, or `>` — still separates what remains.
 */
function removeAttrEdit(ctx: RuleContext, a: Attr, label: string): Edit {
  let start = a.nameStart;
  while (start > 0 && /\s/.test(ctx.source[start - 1] as string)) start--;
  return { start, end: a.valueEnd, replacement: '', label };
}

/** Collapse to one line and clip, for embedding a value inside a message. */
function short(value: string, max = 60): string {
  const t = value.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 3) + '...';
}

/** A manual fix: advice, never an edit. */
function advice(description: string, advisory: string): Fix {
  return { safety: 'manual', edits: [], description, advisory };
}

const MISSING_ALT_ADVISORY =
  'Write what the image communicates in this context and put it in alt="...". ' +
  'If it is purely decorative — a spacer, a flourish, or an icon that repeats text ' +
  'next to it — alt="" is the correct answer, and it must be present and empty rather ' +
  'than absent. A11yFix will not choose between those two cases for you.';

// ---------------------------------------------------------------------------
// A11Y-IMG-001 — <img> with no alt at all
// ---------------------------------------------------------------------------

const imgMissingAlt: Rule = {
  id: 'A11Y-IMG-001',
  title: 'Image has no alt attribute',
  wcag: ['1.1.1'],
  level: 'A',
  severity: 'error',
  summary: 'An <img> with no alt attribute. Reported, never patched: only a person who has seen the image can write it.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'img' || isCustomComponent(el)) continue;
      if (findNamed(el, 'alt') !== undefined) continue;
      if (hasAriaName(el) || isDeclaredDecorative(el)) continue;
      if (hasUnknownProps(ctx, el)) continue;

      const src = literal(el, 'src');
      const where = src === null ? '<img>' : `<img src="${short(src, 48)}">`;
      // `title` is not a substitute: several screen readers never announce it, and those
      // that do treat it as a description rather than a name.
      const titled = namesElement(el, 'title');

      out.push(
        ctx.report({
          ruleId: imgMissingAlt.id,
          wcag: imgMissingAlt.wcag,
          level: 'A',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message:
            `${where} has no alt attribute.` +
            (titled ? ' The title attribute present here does not stand in for it.' : ''),
          impact:
            'A screen reader has nothing to announce for this image, so it falls back to ' +
            (src === null ? 'the file name' : `reading the file name ("${short(src, 40)}")`) +
            ' one character at a time, or skips the image entirely. Either way whatever the ' +
            'image conveys is simply absent for that reader — and if it is a link or a button, ' +
            'they cannot tell what activating it does.',
          fix: advice('No automatic fix: alt text must be written by a person.', MISSING_ALT_ADVISORY),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-IMG-002 — alt that is a file name or a placeholder
// ---------------------------------------------------------------------------

const IMAGE_EXT = 'png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?|heic|heif';
const ENDS_WITH_EXTENSION = new RegExp('\\.(?:' + IMAGE_EXT + ')$', 'i');
const BARE_EXTENSION = new RegExp('^\\.?(?:' + IMAGE_EXT + ')$', 'i');

/** Camera, screenshot and upload file names: DSC_0001, IMG-1234, screenshot 5. */
const CAMERA_NAME = /^(?:dsc[nf]?|img|image|photo|pic|scan|screenshot|screen[-_ ]shot|untitled|download|unnamed|capture|pxl|gopr|mvimg|snap)[-_ ]?\d{1,12}$/i;

/**
 * No letters at all, in any script — dimensions, indexes, decorative punctuation.
 *
 * This was `[^A-Za-z]`, which is a statement that only the Latin alphabet contains
 * words. `alt="Логотип Государственного исторического музея"` has no A-Z in it, so a
 * correct, careful Russian description was reported as carrying no information — and so
 * was every Greek, Georgian, Hebrew, Arabic, Japanese and Chinese one. On the museum site
 * this tool is aimed at, that rule fired 649 times.
 *
 * The Unicode letter class covers every script, including the ideographs that make up a
 * Chinese alt with no spaces in it at all.
 */
const NO_WORDS = /^\P{L}+$/u;

const PLACEHOLDER_ALT = new Set([
  'image', 'images', 'img', 'photo', 'photos', 'photograph', 'picture', 'pictures',
  'pic', 'pics', 'graphic', 'graphics', 'icon', 'logo', 'logo image', 'banner',
  'spacer', 'blank', 'clear', 'transparent', 'dot', 'pixel', 'untitled', 'thumbnail',
  'thumb', 'placeholder', 'alt', 'alt text', 'alt-text', 'image alt', 'image here',
  'photo here', 'description', 'no description', 'none', 'null', 'undefined', 'n/a',
  'na', 'todo', 'tbd', 'test', 'temp', 'dummy', 'asdf', 'figure', 'chart', 'graph',
  'diagram', 'screenshot', 'avatar', 'profile picture', 'media', 'file', 'asset',
  'product image', 'hero image', 'background', 'bg', 'decorative',
  // Russian, because that is the market this tool was pointed at and «Логотип» as the
  // whole of an alt names the medium and stops, exactly as «logo» does. Unlike the link
  // phrases these are not scoped by lang: none of them collides with an English word, and
  // an alt is often the one string on a page nobody set a language for.
  'логотип', 'логотип сайта', 'изображение', 'картинка', 'фото', 'фотография',
  'баннер', 'иконка', 'значок', 'рисунок', 'схема', 'график', 'диаграмма',
  'без названия', 'нет описания', 'нет данных', 'заглушка', 'аватар', 'миниатюра',
  'превью', 'обложка', 'фон', 'разделитель', 'пустое изображение',
  // A truncated "image of" names the medium and then stops. A11Y-IMG-003 deliberately
  // leaves these alone — stripping the prefix would leave an empty alt, which is a claim
  // that the image is decorative — so they are caught here as placeholders instead.
  'image of', 'picture of', 'photo of', 'graphic of', 'an image of', 'a picture of',
]);

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Reduce to comparable letters and digits, so "hero-2x" and "Hero 2X" match.
 *
 * Letters in every script, not `[^a-z0-9]`. The ASCII version annihilated any Cyrillic
 * alt down to whatever Latin it happened to contain, so
 * `alt="Rutube-канал Российской Государственной Библиотеки Искусств"` on `rutube.png`
 * reduced to `rutube` and was reported as a file name dumped into the alt — while the
 * English `alt="Rutube — official channel"` on the same file stayed silent. This is the
 * same assumption as the `[^A-Za-z]` bug three functions above, and it fails the same way:
 * only ever on an alt that contains real description, so every false positive it produces
 * lands on one of the best alt texts on the page.
 */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Does this file name look like something a machine chose?
 *
 * The point of the rule is an author who pasted the file name in rather than describing
 * the picture. But a great many files are named after what they are — `max.svg`,
 * `vk.svg`, `rutube.png` — and for a service icon the service's name is the correct alt,
 * not a lazy one. Ten findings on three sites were social and contact icons named after
 * their destination, which is the recommended pattern, and the worst pair sat on adjacent
 * lines of one page: two <img> with the identical `alt="max"`, one flagged and one not,
 * because the other file happened to be `max-white.svg`. A client who checks one line
 * finds the report contradicting itself.
 *
 * So the stem has to carry the marks of a machine — a digit, an underscore, or more than
 * one hyphen. A single plain word does not, and the classic camera and extension dumps
 * are already caught above.
 */
const MACHINE_STEM = /\d|_|-.*-/;

/** File name of a src, without query string, directory or extension. */
function srcStem(src: string): string {
  const noQuery = src.split(/[?#]/)[0] ?? '';
  const parts = noQuery.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Why this alt text carries no information, or null when it looks like real text. */
function placeholderReason(alt: string, src: string | null): string | null {
  const trimmed = alt.trim();
  if (trimmed === '') return null; // alt="" is the correct decorative marker, not a placeholder.
  const n = normalise(trimmed);

  if (BARE_EXTENSION.test(n)) return 'is a bare file extension';
  if (ENDS_WITH_EXTENSION.test(n)) return 'is a file name';
  if (!/\s/.test(trimmed) && (trimmed.includes('/') || trimmed.includes('\\'))) return 'is a file path';
  if (CAMERA_NAME.test(n)) return 'is a camera or upload file name';
  if (PLACEHOLDER_ALT.has(n)) return 'is a generic placeholder';
  if (NO_WORDS.test(n)) return 'contains no words';
  if (src !== null) {
    const raw = srcStem(src);
    const stem = squash(raw);
    if (stem.length >= 3 && stem === squash(n) && MACHINE_STEM.test(raw)) {
      return 'repeats the file name from src';
    }
  }
  return null;
}

const altIsPlaceholder: Rule = {
  id: 'A11Y-IMG-002',
  title: 'Alt text is a file name or a placeholder',
  wcag: ['1.1.1'],
  level: 'A',
  severity: 'error',
  summary: 'An alt attribute holding a file name, a bare extension or filler like "image" — present, but carrying no information.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'img' || isCustomComponent(el)) continue;
      if (isDeclaredDecorative(el)) continue;

      const alt = findNamed(el, 'alt');
      if (alt === undefined || isExpression(alt) || alt.value === null) continue;

      const reason = placeholderReason(alt.value, literal(el, 'src'));
      if (reason === null) continue;

      out.push(
        ctx.report({
          ruleId: altIsPlaceholder.id,
          wcag: altIsPlaceholder.wcag,
          level: 'A',
          severity: 'error',
          start: alt.nameStart,
          end: alt.valueEnd,
          message: `alt="${short(alt.value, 48)}" ${reason} rather than a description of the image.`,
          impact:
            'The image passes every automated check while telling a screen-reader user ' +
            `nothing: they hear "${short(alt.value, 40)}" where sighted readers see the ` +
            'content. This is worse than an empty alt, because the page now looks fixed to ' +
            'anyone auditing it.',
          fix: advice(
            'No automatic fix: replacing filler with real alt text requires seeing the image.',
            MISSING_ALT_ADVISORY,
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-IMG-003 — alt beginning "image of", "picture of", ...
// ---------------------------------------------------------------------------

/**
 * Only prefixes that name the *medium* are stripped. "Screenshot of" and "logo of"
 * look similar but carry information the role announcement does not supply, so they
 * stay. Anchored, with no nested quantifier, so it cannot backtrack catastrophically.
 */
const REDUNDANT_PREFIX = /^\s*(?:an?\s+)?(?:image|picture|photo|photograph|graphic)\s+(?:of|showing|depicting)\s+/i;

const altRedundantPrefix: Rule = {
  id: 'A11Y-IMG-003',
  title: 'Alt text repeats the role of the element',
  wcag: ['1.1.1'],
  level: 'A',
  severity: 'warning',
  summary: 'Alt text starting "image of" / "picture of" — the screen reader already announced "image", so the word is read twice.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'img' || isCustomComponent(el)) continue;

      const alt = findNamed(el, 'alt');
      if (alt === undefined || isExpression(alt) || alt.value === null) continue;

      const match = REDUNDANT_PREFIX.exec(alt.value);
      if (match === null) continue;
      const prefix = match[0];
      const rest = alt.value.slice(prefix.length);

      let fix: Fix;
      if (rest.trim() === '') {
        // "image of" and nothing else. Deleting it would leave alt="", which is a claim
        // that the image is decorative — a claim only a person can make.
        fix = advice(
          'No automatic fix: removing the prefix would leave the alt text empty.',
          `alt="${short(alt.value, 40)}" says only that this is an image. Replace it with a ` +
            'description of what the image shows, or with alt="" if it is decorative.',
        );
      } else if (!attrSpanIsSafe(ctx, el, alt)) {
        // The recorded value span cannot be trusted — an unterminated quote or a runaway
        // opening tag — so rewriting it would delete source that is not ours to touch.
        fix = advice(
          'No automatic fix: the alt attribute could not be located precisely enough to edit.',
          `Remove the leading "${prefix.trim()}" from this alt text by hand.`,
        );
      } else {
        const next = capitaliseIfPlain(alt.value, rest);
        fix = {
          safety: 'review',
          // valueStart..valueEnd spans the value *including* its quotes, so the
          // replacement has to carry its own quotes; quoteAttrValue picks a delimiter the
          // text does not contain rather than escaping with backslashes, which neither
          // HTML nor JSX understands inside an attribute.
          edits: [
            {
              start: alt.valueStart,
              end: alt.valueEnd,
              replacement: quoteAttrValue(next),
              label: `Drop "${prefix.trim()}" from alt`,
            },
          ],
          description: `Remove the redundant "${prefix.trim()}" prefix, leaving alt="${short(next, 40)}".`,
        };
      }

      out.push(
        ctx.report({
          ruleId: altRedundantPrefix.id,
          wcag: altRedundantPrefix.wcag,
          level: 'A',
          severity: 'warning',
          start: alt.nameStart,
          end: alt.valueEnd,
          message: `alt="${short(alt.value, 48)}" opens with "${prefix.trim()}".`,
          impact:
            'A screen reader announces the element as an image before reading the alt text, ' +
            `so the listener hears "image, ${short(prefix.trim().toLowerCase() + ' ' + rest.trim(), 40)}" ` +
            '— the same word twice, in front of every such image on the page.',
          fix,
        }),
      );
    }
    return out;
  },
};

/**
 * Re-capitalise the remainder only when the first word is plainly lowercase. Blindly
 * upper-casing would turn "image of iPhone 12" into "IPhone 12", which is a different
 * word; leaving a lowercase sentence start is the lesser error, so we only act when the
 * word contains no capitals of its own.
 */
function capitaliseIfPlain(original: string, rest: string): string {
  const startedUpper = /^\s*[A-Z]/.test(original);
  const firstWord = rest.split(/\s/)[0] ?? '';
  if (!startedUpper || !/^[a-z]+$/.test(firstWord)) return rest;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// ---------------------------------------------------------------------------
// A11Y-IMG-004 — <input type="image"> with no alt
// ---------------------------------------------------------------------------

const inputImageMissingAlt: Rule = {
  id: 'A11Y-IMG-004',
  title: 'Image button has no alt attribute',
  wcag: ['1.1.1', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'An <input type="image"> whose alt is missing or empty, leaving the submit button with no accessible name.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'input' || isCustomComponent(el)) continue;

      const typeAttr = findNamed(el, 'type');
      // A computed type may or may not be "image"; do not guess either way.
      if (typeAttr === undefined || isExpression(typeAttr) || typeAttr.value === null) continue;
      if (typeAttr.value.trim().toLowerCase() !== 'image') continue;
      if (hasAriaName(el) || hasUnknownProps(ctx, el)) continue;

      const alt = findNamed(el, 'alt');
      if (alt !== undefined && (isExpression(alt) || (alt.value ?? '').trim() !== '')) continue;

      const empty = alt !== undefined;
      out.push(
        ctx.report({
          ruleId: inputImageMissingAlt.id,
          wcag: inputImageMissingAlt.wcag,
          level: 'A',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message: empty
            ? '<input type="image"> has an empty alt attribute.'
            : '<input type="image"> has no alt attribute.',
          impact:
            'This is a submit button, not a decoration, so it cannot be skipped. With no alt ' +
            'a screen reader announces it as "button" alone, or reads out the image file name, ' +
            'and the only way to learn what submitting does is to submit it.' +
            (empty ? ' An empty alt is right for a decorative image and wrong for a control.' : ''),
          fix: advice(
            'No automatic fix: the button label must be written by a person.',
            'Set alt to the action the button performs — "Search", "Submit order" — not to a ' +
              'description of the picture on it. Unlike a decorative image, this control always ' +
              'needs a non-empty name.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-IMG-005 — <area> with no alt
// ---------------------------------------------------------------------------

const areaMissingAlt: Rule = {
  id: 'A11Y-IMG-005',
  title: 'Image map area has no alt attribute',
  wcag: ['1.1.1', '2.4.4'],
  level: 'A',
  severity: 'error',
  summary: 'An <area> with an href but no alt, leaving one hotspot of an image map unnamed.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'area' || isCustomComponent(el)) continue;
      // An <area> without href is not a link and carries no name requirement.
      if (findNamed(el, 'href') === undefined) continue;
      if (findNamed(el, 'alt') !== undefined) continue;
      if (hasAriaName(el) || hasUnknownProps(ctx, el)) continue;

      const href = literal(el, 'href');
      out.push(
        ctx.report({
          ruleId: areaMissingAlt.id,
          wcag: areaMissingAlt.wcag,
          level: 'A',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message:
            '<area> has an href but no alt attribute' +
            (href === null ? '.' : ` (links to "${short(href, 40)}").`),
          impact:
            'Each area is a separate link in the list a screen-reader user navigates by. ' +
            'Without alt this one is announced by its URL, so a page of hotspots becomes a ' +
            'list of unreadable paths, and the region of the image it covers is invisible to ' +
            'anyone not using a mouse.',
          fix: advice(
            'No automatic fix: the link text must be written by a person.',
            'Give each <area> an alt describing where that hotspot leads, exactly as you would ' +
              'write the text of an ordinary link.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-IMG-006 — <svg> used as an image with no accessible name
// ---------------------------------------------------------------------------

/** A <title> anywhere inside the svg. Cheap, and never a false failure. */
const SVG_TITLE = /<title[\s>/]/i;

/** Roles under which an svg is exposed as a graphic and therefore needs a name. */
const GRAPHIC_ROLES = new Set(['img', 'image', 'graphics-document', 'graphics-symbol', 'graphics-object']);

/**
 * An icon inside a control that already has text is decorative by context: naming it
 * would make the control announce itself twice. Those want `aria-hidden`, which is a
 * different (and much weaker) finding than an unnamed standalone graphic.
 */
function insideNamedControl(el: Element): boolean {
  let node: Element | null = el.parent;
  for (let depth = 0; node !== null && depth < 3; depth++, node = node.parent) {
    if (node.tagLower === 'a' || node.tagLower === 'button' || node.tagLower === 'summary') {
      return namesElement(node, 'aria-label') || namesElement(node, 'aria-labelledby') || textOf(node) !== '';
    }
  }
  return false;
}

const svgMissingName: Rule = {
  id: 'A11Y-IMG-006',
  title: 'Inline SVG has no accessible name',
  wcag: ['1.1.1'],
  level: 'A',
  severity: 'warning',
  summary: 'An <svg> that declares role="img" but has no aria-label and no <title> child.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'svg' || isCustomComponent(el)) continue;
      if (isDeclaredDecorative(el)) continue;
      if (hasAriaName(el) || hasUnknownProps(ctx, el)) continue;
      if (SVG_TITLE.test(el.innerSource)) continue;
      if (insideNamedControl(el)) continue;

      const role = literal(el, 'role');
      // The svg has to say it is a graphic before we can say it is an unnamed one.
      //
      // This used to fire on any `<svg>` with no role, which is the strict reading of the
      // spec and is useless in practice: a modern browser does not expose a role-less
      // inline svg as an image, and virtually every one in a real codebase is a decorative
      // icon sitting next to its own label. On two production sites that reading produced
      // a hundred and two findings, none of which a developer would act on, while the
      // genuine cases — `role="img"` with nothing to announce — were buried among them.
      // Matching what the accessibility tree actually does is both more honest and more
      // useful, and it is the same line axe-core draws.
      if (role === null || !GRAPHIC_ROLES.has(role.trim().toLowerCase())) continue;

      out.push(
        ctx.report({
          ruleId: svgMissingName.id,
          wcag: svgMissingName.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `<svg role="${short(role, 24)}"> is exposed as a graphic but has no aria-label and no <title> child.`,
          impact:
            'The graphic reaches the accessibility tree with no name, so a screen reader ' +
            'announces an empty object or nothing at all. When the svg is the whole content of ' +
            'a link or button, the control is announced as unlabelled and the user has no way ' +
            'to find out what it does.',
          fix: advice(
            'No automatic fix: an svg is either meaningful and needs a name, or decorative and needs hiding.',
            'Add aria-label="..." describing what the graphic conveys, or a <title> as the ' +
              'first child. If it turns out to be decoration next to text that already says the ' +
              'same thing, drop role="img" and add aria-hidden="true" instead. A11yFix cannot ' +
              'tell which of the two this is by reading the path data.',
          ),
        }),
      );
    }
    return out;
  },
};


// ---------------------------------------------------------------------------
// A11Y-IMG-008 — <video> / <audio> with no captions track
// ---------------------------------------------------------------------------

const HAS_TRACK_TAG = /<track[\s>/]/i;

const mediaMissingCaptions: Rule = {
  id: 'A11Y-IMG-008',
  title: 'Media element has no captions track',
  wcag: ['1.2.1', '1.2.2'],
  level: 'A',
  severity: 'warning',
  summary: 'A <video> or <audio> with no <track kind="captions"> child.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const isVideo = el.tagLower === 'video';
      if ((!isVideo && el.tagLower !== 'audio') || isCustomComponent(el)) continue;
      if (isDeclaredDecorative(el)) continue;
      // A muted video has no audio to caption. `muted` may be valueless.
      const muted = findNamed(el, 'muted');
      if (isVideo && muted !== undefined && (muted.value ?? 'true').trim().toLowerCase() !== 'false') continue;

      const tracks = el.children.filter((c) => c.tagLower === 'track');
      // A `kind` we cannot evaluate — `kind={k}`, `:kind="k"` — may well be "captions",
      // and reporting a failure we cannot prove is how a linter gets switched off.
      const unreadableKind = tracks.some((t) => {
        const k = findNamed(t, 'kind');
        return k !== undefined && (isExpression(k) || k.value === null);
      });
      if (unreadableKind) continue;
      const kinds = tracks.map((t) => (literal(t, 'kind') ?? 'subtitles').trim().toLowerCase());
      if (kinds.includes('captions')) continue;
      // Tracks rendered from an expression are invisible to the element walk but leave the
      // tag name in the source; treat any mention as "cannot prove missing".
      if (tracks.length === 0 && HAS_TRACK_TAG.test(el.innerSource)) continue;

      const onlySubtitles = kinds.includes('subtitles');
      out.push(
        ctx.report({
          ruleId: mediaMissingCaptions.id,
          wcag: mediaMissingCaptions.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: onlySubtitles
            ? `<${el.tagLower}> has a subtitles track but no <track kind="captions">.`
            : `<${el.tagLower}> has no <track kind="captions"> child.`,
          impact: isVideo
            ? 'A viewer who is deaf or hard of hearing gets the picture and none of the ' +
              'dialogue, so anything said and any meaningful sound — an alarm, a name, a ' +
              'price — is lost.' +
              (onlySubtitles
                ? ' Subtitles translate speech only; captions also carry the speaker and the ' +
                  'non-speech audio, which is what this criterion asks for.'
                : '')
            : 'Audio-only content with no captions or transcript is completely unavailable to a ' +
              'deaf user, and unusable for anyone in a place where they cannot play sound.',
          fix: advice(
            'No automatic fix: captions are a media asset, not a markup change.',
            isVideo
              ? 'Add a caption file and reference it: <track kind="captions" srclang="en" ' +
                'src="..." label="English">. Captions must be accurate and time-aligned, so ' +
                'auto-generated output needs a human pass before it counts.'
              : 'Provide a transcript next to the player, or add <track kind="captions"> if the ' +
                'audio is presented with a visual component.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-IMG-009 — <object> / <embed> with no fallback and no name
// ---------------------------------------------------------------------------

/** Children of <object> that configure it rather than serve as fallback content. */
const NON_FALLBACK_CHILDREN = new Set(['param', 'source', 'track']);

const embeddedMissingAlternative: Rule = {
  id: 'A11Y-IMG-009',
  title: 'Embedded object has no text alternative',
  wcag: ['1.1.1'],
  level: 'A',
  severity: 'warning',
  summary: 'An <object> with no fallback content, or an <embed>, carrying no aria-label or title.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const isObject = el.tagLower === 'object';
      if ((!isObject && el.tagLower !== 'embed') || isCustomComponent(el)) continue;
      if (isDeclaredDecorative(el)) continue;
      if (hasAriaName(el) || namesElement(el, 'title') || hasUnknownProps(ctx, el)) continue;

      if (isObject) {
        const hasFallbackElement = el.children.some((c) => !NON_FALLBACK_CHILDREN.has(c.tagLower));
        if (hasFallbackElement || textOf(el) !== '') continue;
      }

      const type = literal(el, 'type');
      out.push(
        ctx.report({
          ruleId: embeddedMissingAlternative.id,
          wcag: embeddedMissingAlternative.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: isObject
            ? `<object${type === null ? '' : ` type="${short(type, 32)}"`}> has neither fallback content nor an accessible name.`
            : `<embed${type === null ? '' : ` type="${short(type, 32)}"`}> has no accessible name.`,
          impact:
            'The embedded content is opaque to the accessibility tree: a screen reader ' +
            'announces an unnamed embedded object, and if the plugin or format is unsupported ' +
            'the reader gets a blank rectangle with nothing to explain what was meant to be ' +
            'there. Keyboard users may also be dropped inside it with no way back out.',
          fix: advice(
            'No automatic fix: the alternative describes content this tool cannot see.',
            isObject
              ? 'Put real fallback content between <object> and </object> — a sentence, a link ' +
                'to the file, or an <img> with its own alt — and add title or aria-label naming ' +
                'what is embedded.'
              : '<embed> takes no fallback content, so give it aria-label or title, or replace it ' +
                'with an <object> that has fallback content inside it.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-IMG-010 — decorative alt="" contradicted by title / aria-label
// ---------------------------------------------------------------------------

const decorativeAltConflict: Rule = {
  id: 'A11Y-IMG-010',
  title: 'Decorative image also carries a label',
  wcag: ['1.1.1'],
  level: 'A',
  severity: 'warning',
  summary: 'An image with alt="" that also has a title or aria-label — one says "ignore me", the other says "announce this".',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'img' || isCustomComponent(el)) continue;

      const alt = findNamed(el, 'alt');
      if (alt === undefined || isExpression(alt)) continue;
      if ((alt.value ?? '').trim() !== '') continue;
      if (isDeclaredDecorative(el)) continue; // aria-hidden already resolves the contradiction.

      const conflicting: Attr[] = [];
      for (const name of ['title', 'aria-label', 'aria-labelledby']) {
        const a = findNamed(el, name);
        if (a !== undefined && (isExpression(a) || (a.value ?? '').trim() !== '')) conflicting.push(a);
      }
      if (conflicting.length === 0) continue;

      const names = conflicting.map((a) => a.name).join(' and ');
      // Removing an expression-valued attribute deletes code whose behaviour we cannot
      // see, so those are reported without a patch — and so is any attribute whose
      // recorded span we cannot vouch for, since `removeAttrEdit` deletes that span
      // outright and an unterminated quote makes it reach into the next element.
      const editable = conflicting.filter((a) => !isExpression(a) && attrSpanIsSafe(ctx, el, a));

      const fix: Fix =
        editable.length === conflicting.length
          ? {
              safety: 'review',
              edits: editable.map((a) => removeAttrEdit(ctx, a, `Remove ${a.name} from decorative image`)),
              // alt="" is the author's explicit statement that the image is decorative, so the
              // mechanical resolution honours it and drops the label. The other direction —
              // promoting the label into alt — is a judgement about what the image means, which
              // is why this is `review` and not `automatic`.
              description:
                `Remove ${names}, keeping the image decorative as alt="" declares. ` +
                'If the image is in fact meaningful, move that text into alt instead.',
            }
          : advice(
              'No automatic fix: the conflicting label is an expression, or sits in markup too ' +
                'malformed to edit safely.',
              `Decide whether the image is decorative — then drop ${names} — or meaningful, and ` +
                'move the text into alt.',
            );

      out.push(
        ctx.report({
          ruleId: decorativeAltConflict.id,
          wcag: decorativeAltConflict.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `<img alt=""> is marked decorative but also carries ${names}.`,
          impact:
            'The two attributes make opposite claims, and assistive technologies resolve them ' +
            'differently: some skip the image because alt is empty, others announce the title ' +
            'or label. The same page therefore reads differently on different screen readers, ' +
            'and whichever behaviour you tested is not the one every user gets.',
          fix,
        }),
      );
    }
    return out;
  },
};

export const RULES: readonly Rule[] = [
  imgMissingAlt,
  altIsPlaceholder,
  altRedundantPrefix,
  inputImageMissingAlt,
  areaMissingAlt,
  svgMissingName,
  mediaMissingCaptions,
  embeddedMissingAlternative,
  decorativeAltConflict,
];
