/**
 * Document structure and semantics.
 *
 * These rules are about the skeleton a screen-reader user navigates by: the document
 * language, the title, the heading outline, lists, tables, landmarks. Almost none of
 * them can be fixed by inventing text, so most emit advice rather than a patch — and
 * the few that do patch only touch attributes whose correct value is forced by the
 * position of the element, never by what the element means.
 *
 * PRECISION: a JSX/Vue/Svelte component file is a *fragment*, not a document. Rules
 * that reason about the document as a whole (lang, title, the h1 count, landmarks,
 * skip links) are gated behind `isDocument()`, which requires a real <html> or <body>
 * in the source. Without that gate this family would fire on every component in a
 * repository and the tool would be uninstallable.
 */

import type { Edit, Fix, FixSafety, Rule, RuleContext, Violation } from '../types.js';
import { TODO_MARKER } from '../types.js';
import type { Attr, Element } from '../parse/markup.js';
import { getAttr, hasAttr, textOf, positionAt } from '../parse/markup.js';
import { isDocumentRootComponent } from '../parse/imports.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A tag beginning with a capital is a component (`<Image />`, `<Card />`), not the
 * HTML element it resembles. We cannot see its props or what it renders, so rules that
 * reason about HTML semantics must leave it alone. The cost is that legacy all-caps
 * HTML (`<TABLE>`) is skipped too — a miss, never a corruption.
 */
function isComponent(el: Element): boolean {
  return /^[A-Z]/.test(el.tag);
}

/** True when this file is a whole document rather than a component fragment. */
function isDocument(ctx: RuleContext): boolean {
  return ctx.markup.elements.some((el) => el.tagLower === 'html' || el.tagLower === 'body');
}

/**
 * True when the file composes components we cannot see into.
 *
 * "There is no <main>" and "there is no skip link" are claims about the whole rendered
 * page. In a Next.js `_document.tsx` or an Astro layout the page's main content arrives
 * through `<Main />` or `<slot />`, so the claim would be false and unfixable at this
 * location. Restricting those two rules to fully literal documents is what keeps them
 * from becoming noise.
 */
function hasOpaqueContent(ctx: RuleContext): boolean {
  return ctx.markup.elements.some(
    (el) => isComponent(el) || el.tagLower === 'slot' || el.tagLower === 'template',
  );
}

function firstElement(ctx: RuleContext, tagLower: string): Element | undefined {
  return ctx.markup.elements.find((el) => el.tagLower === tagLower && !isComponent(el));
}

/** The element a document-wide finding should point at: <body>, else <html>. */
function documentAnchor(ctx: RuleContext): Element | undefined {
  return firstElement(ctx, 'body') ?? firstElement(ctx, 'html');
}

/**
 * Offset to insert a new attribute at: just before the '>' of the opening tag.
 *
 * HTML void elements report `selfClosing` with no '/' in the source, so the character
 * has to be checked rather than the flag, or the insert lands one byte too early and
 * eats the tag.
 */
function attrInsertPoint(source: string, el: Element): number {
  return el.openEnd - (el.selfClosing && source[el.openEnd - 2] === '/' ? 2 : 1);
}

/**
 * A zero-width edit that adds one attribute to an opening tag. The separating space is
 * dropped when the source already has whitespace there (`<iframe src="/a" />`), so the
 * patch does not leave a double space in the diff.
 */
function addAttribute(ctx: RuleContext, el: Element, attr: string, label: string): Edit {
  const at = attrInsertPoint(ctx.source, el);
  const prev = ctx.source[at - 1];
  const sep = prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' ? '' : ' ';
  return { start: at, end: at, replacement: sep + attr, label };
}

/** An attribute's value only when it is a literal we may reason about and rewrite. */
function literalAttr(el: Element, name: string): string | undefined {
  const a = getAttr(el, name);
  if (a === undefined) return undefined;
  if (a.dynamic || a.quote === '{') return undefined;
  return a.value === null ? undefined : a.value;
}

/** The binding syntaxes that set a plain HTML attribute from an expression. */
const BINDING_PREFIXES = ['', ':', 'v-bind:', 'x-bind:', 'bind:'] as const;

/**
 * Find an attribute under any of its bound spellings — `title`, `:title`,
 * `v-bind:title`. A bound attribute means the value *is* being set, just not by
 * anything we can read, so treating it as absent and adding a literal beside it would
 * produce a duplicate attribute in working code.
 */
function boundAttrOf(el: Element, name: string): Attr | undefined {
  const lower = name.toLowerCase();
  return el.attrs.find((a) => BINDING_PREFIXES.some((p) => a.nameLower === p + lower));
}

/**
 * True when the opening tag carries brace syntax whose attributes the tokenizer cannot
 * enumerate: a JSX spread (`{...props}`) or Svelte shorthand (`{title}`). We must not
 * claim an attribute is missing from a tag whose attribute list we cannot see in full.
 * The lookbehind keeps `title={expr}` — a brace we *can* read — out of the match.
 */
function hasUnreadableAttrs(ctx: RuleContext, el: Element): boolean {
  const open = ctx.source.slice(el.openStart, el.openEnd);
  return /(?<![=\w])\{\s*(?:\.\.\.|[A-Za-z_$][\w$]*\s*\})/.test(open);
}

/** True when the element carries one of these ARIA roles as a literal token. */
function hasRole(el: Element, ...roles: readonly string[]): boolean {
  const raw = literalAttr(el, 'role');
  if (raw === undefined) return false;
  const tokens = raw.toLowerCase().split(/\s+/);
  return roles.some((r) => tokens.includes(r));
}

/** True when any attribute on the element supplies an accessible name. */
function hasAriaName(el: Element): boolean {
  return boundAttrOf(el, 'aria-label') !== undefined || boundAttrOf(el, 'aria-labelledby') !== undefined;
}

function isAriaHidden(el: Element): boolean {
  return literalAttr(el, 'aria-hidden') === 'true';
}

/** Nearest ancestor matching a predicate, not counting the element itself. */
function closestAncestor(el: Element, pred: (a: Element) => boolean): Element | undefined {
  let cur = el.parent;
  while (cur !== null) {
    if (pred(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function insideSvg(el: Element): boolean {
  return closestAncestor(el, (a) => a.tagLower === 'svg') !== undefined;
}

/**
 * Template interpolation inside an otherwise static value: `id="row-{{ i }}"`,
 * `id="item-${n}"`, `<title><%= t %></title>`. The text is generated, so neither its
 * emptiness nor its uniqueness can be judged from the source.
 */
function looksInterpolated(text: string): boolean {
  return text.includes('{') || text.includes('$') || text.includes('<%') || text.includes('<?');
}

/** An advisory carries no edits: `fixAllowed()` refuses any fix that sets `advisory`. */
function advice(safety: FixSafety, description: string, advisory: string): Fix {
  return { safety, edits: [], description, advisory };
}

function lineOf(ctx: RuleContext, offset: number): number {
  return positionAt(ctx.source, offset).line;
}

// ---------------------------------------------------------------------------
// A11Y-DOC-001 / 002 — document language
// ---------------------------------------------------------------------------

/**
 * `lang` under any of the binding syntaxes the parser preserves verbatim. A Vue
 * `:lang` or a JSX `lang={locale}` means the language *is* being set, just not by a
 * value we can read — reporting it as missing would be plainly wrong.
 */
function langAttrOf(el: Element): Attr | undefined {
  return boundAttrOf(el, 'lang') ?? getAttr(el, 'xml:lang');
}

/**
 * Shape check only — is this even a language tag? We deliberately do not validate
 * against the IANA registry: `lang="qtz"` is a private-use code we should not reject,
 * while `lang="english"` cannot be a tag under any registry because the primary subtag
 * is two or three letters. Splitting on '-' and checking each subtag separately keeps
 * this linear; a single monolithic regex here is a backtracking hazard for no gain.
 */
function isPlausibleLanguageTag(value: string): boolean {
  const tag = value.trim();
  if (tag.length === 0 || tag.length > 35) return false;
  // Private-use ("x-klingon") and grandfathered ("i-navajo") tags.
  if (/^[xi]-[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) return true;
  const parts = tag.split('-');
  const primary = parts[0] ?? '';
  if (!/^[A-Za-z]{2,3}$/.test(primary)) return false;
  for (let i = 1; i < parts.length; i++) {
    if (!/^[A-Za-z0-9]{1,8}$/.test(parts[i] as string)) return false;
  }
  return true;
}

/**
 * The only repairs we will make to a malformed tag are mechanical ones: trimming
 * surrounding whitespace and swapping the POSIX locale separator for a hyphen
 * (`en_US` -> `en-US`). Both preserve the language the author already chose. Anything
 * else — "english" -> "en" — is a guess about a human's intent, and getting it wrong
 * makes every checker downstream report the page as correct.
 */
function mechanicalLangRepair(raw: string): string | undefined {
  const candidate = raw.trim().replace(/_/g, '-');
  if (candidate === raw) return undefined;
  return isPlausibleLanguageTag(candidate) ? candidate : undefined;
}

const htmlHasLang: Rule = {
  id: 'A11Y-DOC-001',
  title: 'Document has no language',
  wcag: ['3.1.1'],
  level: 'A',
  severity: 'error',
  summary: 'The <html> element must declare the page language with lang.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'html') continue;
      if (langAttrOf(el) !== undefined) continue;
      // <html {...attrs}> may already be receiving lang through a spread we cannot read.
      if (hasUnreadableAttrs(ctx, el)) continue;
      // <Html> is a component, and only some components are the document root. The one
      // from next/document is, and a missing lang there is a real and very common bug.
      // The one from @react-email/components is an email wrapper that sets its own
      // language. Anything else we have not seen the implementation of, and asserting a
      // missing attribute on a component we cannot read is asserting a fact we do not
      // have — so it stays quiet.
      if (isComponent(el) && !isDocumentRootComponent(ctx.source, el.tag)) continue;

      const message = 'The <html> element has no lang attribute.';
      const impact =
        'A screen reader falls back to the language of the user\'s own system, so an ' +
        'English page can be read aloud with French pronunciation rules — the words ' +
        'come out as noise. Braille displays choose the wrong contraction table for ' +
        'the same reason.';

      // We refuse to infer the language from the content. Guessing "en" because the
      // markup happens to be in English is exactly the failure mode above, only now
      // it is asserted by the file and nobody will look at it again. The patch opens
      // the slot and plants a marker that fails CI until a human fills it in.
      let fix: Fix;
      if (isComponent(el)) {
        fix = advice(
          'manual',
          'Set the page language on the document root.',
          'This <' + el.tag + '> is a component; add a lang prop with the page\'s ' +
            'BCP 47 language tag (for example lang="en-GB") wherever it forwards ' +
            'attributes to the html element.',
        );
      } else {
        fix = {
          safety: 'review',
          edits: [
            addAttribute(ctx, el, 'lang=""', 'add an empty lang to <html>'),
          ],
          description:
            'Add an empty lang attribute for a human to fill in. lang="" is the standard ' +
            '"language unknown" value, so it is never worse than the current state, and ' +
            'A11Y-DOC-002 then fails CI until the real tag is written.',
        };
      }

      out.push(
        ctx.report({
          ruleId: htmlHasLang.id,
          wcag: htmlHasLang.wcag,
          level: htmlHasLang.level,
          severity: htmlHasLang.severity,
          start: el.openStart,
          end: el.openEnd,
          message,
          impact,
          fix,
        }),
      );
    }
    return out;
  },
};

const htmlLangValid: Rule = {
  id: 'A11Y-DOC-002',
  title: 'Document language is not a valid language tag',
  wcag: ['3.1.1'],
  level: 'A',
  severity: 'error',
  summary: 'lang must be a BCP 47 tag such as "en" or "pt-BR", not a language name.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'html') continue;
      const attr = langAttrOf(el);
      if (attr === undefined) continue;
      // An expression sets the value at runtime; there is nothing here to validate.
      if (attr.dynamic || attr.quote === '{') continue;
      const raw = attr.value;
      if (raw === null) continue;
      if (isPlausibleLanguageTag(raw)) continue;

      const empty = raw.trim() === '';
      const repair = empty ? undefined : mechanicalLangRepair(raw);
      const fix: Fix =
        repair === undefined
          ? advice(
              'manual',
              empty
                ? 'Replace the empty lang with this page\'s BCP 47 tag.'
                : 'Replace the language name with its BCP 47 tag.',
              empty
                ? 'lang="" is the standard "language unknown" value. It is a placeholder, ' +
                  'not an answer: a screen reader still falls back to the language of the ' +
                  'listener\'s own system. Write the tag for the language this page is ' +
                  'actually in: en, en-GB, pt-BR, zh-Hant.'
                : 'Use the two- or three-letter code for this language, optionally with a ' +
                  'region: en, en-GB, pt-BR, zh-Hant. Only a human knows which language ' +
                  '"' + raw + '" was meant to name.',
            )
          : {
              safety: 'review',
              edits: [
                {
                  start: attr.valueStart,
                  end: attr.valueEnd,
                  replacement: JSON.stringify(repair),
                  label: 'normalise lang to "' + repair + '"',
                },
              ],
              description:
                'Rewrite ' + JSON.stringify(raw) + ' as ' + JSON.stringify(repair) +
                '. This only changes separators and whitespace; the language the author ' +
                'chose is preserved.',
            };

      out.push(
        ctx.report({
          ruleId: htmlLangValid.id,
          wcag: htmlLangValid.wcag,
          level: htmlLangValid.level,
          severity: htmlLangValid.severity,
          start: attr.nameStart,
          end: attr.valueEnd,
          message: empty
            ? 'lang="" declares the page language unknown; it names no language.'
            : 'lang="' + raw + '" is not a valid language tag.',
          impact:
            'Assistive technology cannot match this to a voice, so it keeps whatever ' +
            'voice the user already had — usually their system default. The page is ' +
            'then read with the wrong pronunciation, and the author believes the ' +
            'language has been declared.',
          fix,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-003 — page title
// ---------------------------------------------------------------------------

/** The <title> of the document, ignoring the unrelated <title> inside an <svg>. */
function documentTitle(ctx: RuleContext): Element | undefined {
  return ctx.markup.elements.find(
    (el) => el.tagLower === 'title' && !isComponent(el) && !insideSvg(el),
  );
}

const documentHasTitle: Rule = {
  id: 'A11Y-DOC-003',
  title: 'Document has no title',
  wcag: ['2.4.2'],
  level: 'A',
  severity: 'error',
  summary: 'Every page needs a non-empty <title> describing its topic or purpose.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    if (!isDocument(ctx)) return [];
    const out: Violation[] = [];
    const title = documentTitle(ctx);

    const impact =
      'The title is the first thing a screen reader announces on load and it is the ' +
      'only label the user has when tabbing between browser tabs or picking a page out ' +
      'of their history. Without it they hear the URL, or "Untitled", and have to read ' +
      'the page to find out where they landed.';

    if (title === undefined) {
      // Only claim a missing title when a literal <head> is present. Frameworks that
      // set the title elsewhere (Next.js `metadata`, next/head, vue-meta) legitimately
      // have <html>/<body> with no <head> in this file, and reporting them would be a
      // finding nobody can act on at this location.
      const head = firstElement(ctx, 'head');
      if (head === undefined) return out;

      const canInsert = !head.selfClosing && head.end > head.openEnd;
      const fix: Fix = canInsert
        ? {
            safety: 'manual',
            edits: [
              {
                start: head.openEnd,
                end: head.openEnd,
                replacement:
                  '\n    <title>' + TODO_MARKER + ': name this page</title>',
                label: 'insert a <title> placeholder',
              },
            ],
            description:
              'Insert a <title> containing a TODO marker. Only a human knows what this ' +
              'page is for, so the marker fails CI until the real title is written.',
          }
        : advice(
            'manual',
            'Add a <title> to the document head.',
            'Give the page a short title that names it specifically, most distinctive ' +
              'words first, e.g. "Order history — Acme".',
          );

      out.push(
        ctx.report({
          ruleId: documentHasTitle.id,
          wcag: documentHasTitle.wcag,
          level: documentHasTitle.level,
          severity: documentHasTitle.severity,
          start: head.openStart,
          end: head.openEnd,
          message: 'The document <head> contains no <title> element.',
          impact,
          fix,
        }),
      );
      return out;
    }

    // A title whose text is produced at runtime cannot be judged empty from source.
    if (looksInterpolated(title.innerSource)) return out;
    if (textOf(title) !== '') return out;

    const contentEnd = title.openEnd + title.innerSource.length;
    const canReplace =
      title.end > title.openEnd && ctx.source.slice(title.openEnd, contentEnd) === title.innerSource;
    const fix: Fix = canReplace
      ? {
          safety: 'manual',
          edits: [
            {
              start: title.openEnd,
              end: contentEnd,
              replacement: TODO_MARKER + ': name this page',
              label: 'mark the empty <title> for a human',
            },
          ],
          description:
            'Put a TODO marker inside the empty <title>. Inventing a page title would ' +
            'satisfy every automated checker while telling the user nothing true.',
        }
      : advice(
          'manual',
          'Write the page title.',
          'Give the page a short title that names it specifically, most distinctive ' +
            'words first, e.g. "Order history — Acme".',
        );

    out.push(
      ctx.report({
        ruleId: documentHasTitle.id,
        wcag: documentHasTitle.wcag,
        level: documentHasTitle.level,
        severity: documentHasTitle.severity,
        start: title.openStart,
        end: title.end,
        message: 'The <title> element is empty.',
        impact,
        fix,
      }),
    );
    return out;
  },
};

// ---------------------------------------------------------------------------
// Heading model, shared by A11Y-DOC-004 and A11Y-DOC-005
// ---------------------------------------------------------------------------

interface Heading {
  readonly el: Element;
  readonly level: number;
  /** True for a real h1–h6 tag, false for role="heading" with aria-level. */
  readonly native: boolean;
}

function headingsOf(ctx: RuleContext): Heading[] {
  const out: Heading[] = [];
  for (const el of ctx.markup.elements) {
    if (isComponent(el)) continue;
    const m = /^h([1-6])$/.exec(el.tagLower);
    if (m !== null) {
      // An explicit role wins over the tag: <h4 role="presentation"> is not a heading.
      if (hasAttr(el, 'role') && !hasRole(el, 'heading')) continue;
      const declared = literalAttr(el, 'aria-level');
      const overridden = declared !== undefined && /^[1-9]$/.test(declared.trim());
      out.push({
        el,
        level: overridden ? Number(declared) : Number(m[1]),
        native: !overridden,
      });
      continue;
    }
    if (hasRole(el, 'heading')) {
      const declared = literalAttr(el, 'aria-level');
      if (declared === undefined || !/^[1-9]$/.test(declared.trim())) continue;
      out.push({ el, level: Number(declared), native: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A11Y-DOC-004 — heading levels must not skip
// ---------------------------------------------------------------------------

/** Source range of the tag name inside a well-formed closing tag, or undefined. */
function closingTagName(ctx: RuleContext, el: Element): { start: number; end: number } | undefined {
  if (el.end <= el.openEnd) return undefined;
  const open = ctx.source.lastIndexOf('<', el.end - 1);
  if (open < 0 || open < el.openEnd) return undefined;
  const slice = ctx.source.slice(open, el.end);
  const m = /^<\/(\s*)([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(slice);
  if (m === null) return undefined;
  const name = m[2] as string;
  if (name.toLowerCase() !== el.tagLower) return undefined;
  const nameStart = open + 2 + (m[1] as string).length;
  return { start: nameStart, end: nameStart + name.length };
}

const headingOrder: Rule = {
  id: 'A11Y-DOC-004',
  title: 'Heading level skipped',
  wcag: ['1.3.1'],
  level: 'A',
  severity: 'warning',
  summary: 'Heading levels must descend one at a time; an h2 cannot be followed by an h4.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    const headings = headingsOf(ctx);
    // Never report the first heading in a file: a component may legitimately start at
    // h3 because of where it is mounted, and we cannot see the page around it.
    for (let i = 1; i < headings.length; i++) {
      const cur = headings[i] as Heading;
      const prev = headings[i - 1] as Heading;
      if (cur.level <= prev.level + 1) continue;

      const wanted = prev.level + 1;
      // Patch only the unambiguous case: a plain heading tag exactly two levels below
      // its predecessor, carrying no role or aria-level that a rename would contradict,
      // and with a closing tag we can see. Anything else is a restructuring decision.
      const closing = closingTagName(ctx, cur.el);
      const patchable =
        cur.native &&
        cur.level === prev.level + 2 &&
        !hasAttr(cur.el, 'role') &&
        !hasAttr(cur.el, 'aria-level') &&
        closing !== undefined &&
        // Tag name is exactly "h" + digit, so the digit is at a known offset.
        ctx.source.slice(cur.el.openStart + 1, cur.el.openStart + 3) === cur.el.tagLower;

      const fix: Fix =
        patchable && closing !== undefined
          ? {
              safety: 'review',
              edits: [
                {
                  start: cur.el.openStart + 2,
                  end: cur.el.openStart + 3,
                  replacement: String(wanted),
                  label: 'open <h' + cur.level + '> becomes <h' + wanted + '>',
                },
                {
                  start: closing.end - 1,
                  end: closing.end,
                  replacement: String(wanted),
                  label: 'close </h' + cur.level + '> becomes </h' + wanted + '>',
                },
              ],
              description:
                'Promote this h' + cur.level + ' to h' + wanted + ' so it follows the ' +
                'h' + prev.level + ' above it without a gap. Review that this section ' +
                'really is a child of that one and not the start of a new top-level ' +
                'section, which would instead call for a new h' + prev.level + '.',
            }
          : advice(
              'review',
              'Renumber the headings so levels descend one at a time.',
              'This heading is h' + cur.level + ' but the outline is only at h' +
                prev.level + '. Either promote it to h' + wanted + ' or add the ' +
                'intermediate heading the outline is missing.',
            );

      out.push(
        ctx.report({
          ruleId: headingOrder.id,
          wcag: headingOrder.wcag,
          level: headingOrder.level,
          severity: headingOrder.severity,
          start: cur.el.openStart,
          end: cur.el.openEnd,
          message:
            'Heading level jumps from h' + prev.level + ' to h' + cur.level +
            ', skipping h' + wanted + '.',
          impact:
            'Screen-reader users navigate long pages by jumping heading to heading and ' +
            'read the levels as an outline. A gap makes it sound as though a section ' +
            'was missed, so they go back looking for content that was never there.',
          fix,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-005 — exactly one h1
// ---------------------------------------------------------------------------

const singleH1: Rule = {
  id: 'A11Y-DOC-005',
  title: 'Page does not have exactly one h1',
  wcag: [],
  level: 'A',
  severity: 'warning',
  summary: 'A page should have exactly one top-level heading naming it.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    if (!isDocument(ctx)) return [];
    const out: Violation[] = [];
    const h1s = headingsOf(ctx).filter((h) => h.level === 1);

    if (h1s.length === 0) {
      // With components or slots in the file, the h1 may well be rendered by content
      // we cannot see; asserting its absence would be a guess.
      if (hasOpaqueContent(ctx)) return out;
      const anchor = documentAnchor(ctx);
      if (anchor === undefined) return out;
      out.push(
        ctx.report({
          ruleId: singleH1.id,
          wcag: singleH1.wcag,
          level: singleH1.level,
          severity: singleH1.severity,
          start: anchor.openStart,
          end: anchor.openEnd,
          message: 'The document contains no h1.',
          impact:
            'The h1 is what a screen-reader user jumps to first to confirm which page ' +
            'they are on. Without one the heading outline has no root, and "jump to ' +
            'first heading" lands them somewhere in the middle of the page.',
          fix: advice(
            'manual',
            'Add one h1 naming the page.',
            'Promote the heading that names this page to h1 — usually the visible page ' +
              'title. Do not add a hidden one; the outline should match what is on screen.',
          ),
        }),
      );
      return out;
    }

    const first = h1s[0] as Heading;
    for (let i = 1; i < h1s.length; i++) {
      const extra = h1s[i] as Heading;
      out.push(
        ctx.report({
          ruleId: singleH1.id,
          wcag: singleH1.wcag,
          level: singleH1.level,
          severity: singleH1.severity,
          start: extra.el.openStart,
          end: extra.el.openEnd,
          message:
            'This is h1 number ' + (i + 1) + ' in the document; the first is on line ' +
            lineOf(ctx, first.el.openStart) + '.',
          impact:
            'Two h1s describe two different pages. A screen-reader user listing the ' +
            'headings sees the document split into competing top-level sections and ' +
            'cannot tell which one names the page they are on.',
          fix: advice(
            'review',
            'Demote the extra h1 to the level its section actually sits at.',
            'Keep the h1 that names the page and make this one an h2 (or deeper), ' +
              'matching how the section nests under it.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-006 — duplicate id
// ---------------------------------------------------------------------------

const uniqueIds: Rule = {
  id: 'A11Y-DOC-006',
  title: 'Duplicate id',
  wcag: ['1.3.1', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'id values must be unique; ARIA references resolve to the first match only.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const byId = new Map<string, Element[]>();
    // ids apply to any element, components included: an `id` prop almost always lands
    // on a DOM node. We only skip values we cannot read as literals.
    for (const el of ctx.markup.elements) {
      const raw = literalAttr(el, 'id');
      if (raw === undefined) continue;
      const id = raw.trim();
      if (id === '' || looksInterpolated(id)) continue;
      const bucket = byId.get(id);
      if (bucket === undefined) byId.set(id, [el]);
      else bucket.push(el);
    }

    const out: Violation[] = [];
    for (const [id, els] of byId) {
      if (els.length < 2) continue;
      const lines = els.map((e) => lineOf(ctx, e.openStart));
      // One collision is one finding, reported at the first occurrence and listing the
      // rest. Emitting a violation per element was technically defensible and useless in
      // practice: on a real component library the same id repeated four times filled a
      // screen with four paragraphs describing one thing, and the reader's conclusion was
      // that the tool is noisy rather than that the file has a bug.
      const first = els[0] as Element;
      const attr = getAttr(first, 'id');
      const rest = lines.slice(1);
      out.push(
        ctx.report({
          ruleId: uniqueIds.id,
          wcag: uniqueIds.wcag,
          level: uniqueIds.level,
          severity: uniqueIds.severity,
          start: attr === undefined ? first.openStart : attr.nameStart,
          end: attr === undefined ? first.openEnd : attr.valueEnd,
          message:
            'id="' + id + '" is used ' + els.length + ' times in this file. This is the ' +
            'first; the other' + (rest.length === 1 ? ' is' : 's are') + ' on line' +
            (rest.length === 1 ? ' ' : 's ') + rest.join(', ') + '.',
          impact:
            'aria-labelledby, aria-describedby, aria-controls and <label for> all ' +
            'resolve to the first element with the id and stop. Every later ' +
            'duplicate silently borrows the first one\'s label, so a screen reader ' +
            'announces the wrong name for the control the user is actually on.',
          // Renaming is not ours to do: the id is a contract with stylesheets,
          // scripts, tests and inbound #fragment links we cannot see from here.
          fix: advice(
            'manual',
            'Give each element a unique id.',
            'Rename all but one occurrence of "' + id + '", then update every CSS ' +
              'selector, querySelector call, label[for], aria-* reference and #' + id +
              ' link that pointed at the renamed elements.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-007 / 008 — list structure
// ---------------------------------------------------------------------------

const LIST_TAGS = new Set(['ul', 'ol', 'menu']);
/** Content that is not a list item but is legal or invisible inside a list. */
const LIST_TRANSPARENT = new Set(['script', 'template', 'style', 'slot', 'li']);

const listChildren: Rule = {
  id: 'A11Y-DOC-007',
  title: 'List contains a child that is not a list item',
  wcag: ['1.3.1'],
  level: 'A',
  severity: 'error',
  summary: '<ul> and <ol> may only contain <li> (plus <script> and <template>).',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const list of ctx.markup.elements) {
      if (isComponent(list) || !LIST_TAGS.has(list.tagLower)) continue;
      // A list rebuilt as something else with ARIA is out of scope for this rule.
      if (hasAttr(list, 'role') && !hasRole(list, 'list')) continue;

      for (const child of list.children) {
        if (LIST_TRANSPARENT.has(child.tagLower)) continue;
        // <Item /> inside a <ul> renders an <li> often enough that flagging it would
        // be wrong more often than right.
        if (isComponent(child)) continue;
        if (hasRole(child, 'listitem')) continue;

        out.push(
          ctx.report({
            ruleId: listChildren.id,
            wcag: listChildren.wcag,
            level: listChildren.level,
            severity: listChildren.severity,
            start: child.openStart,
            end: child.openEnd,
            message:
              '<' + child.tag + '> is a direct child of <' + list.tag + '>, which may ' +
              'only contain <li>.',
            impact:
              'A screen reader announces "list, N items" and lets the user jump item ' +
              'to item. Content outside an <li> is not counted and, in several ' +
              'browsers, is dropped from the list entirely — so it is never reached ' +
              'that way and the item count the user is given is wrong.',
            fix: advice(
              'review',
              'Wrap the content in an <li>, or move it outside the list.',
              'If <' + child.tag + '> is one of the items, wrap it in <li>. If it is ' +
                'decoration or a heading for the list, move it before the <' + list.tag +
                '> instead.',
            ),
          }),
        );
      }
    }
    return out;
  },
};

const orphanListItem: Rule = {
  id: 'A11Y-DOC-008',
  title: 'List item outside a list',
  wcag: ['1.3.1'],
  level: 'A',
  severity: 'error',
  summary: '<li> must be inside a <ul>, <ol> or <menu>.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'li' || isComponent(el)) continue;
      // A root-level <li> is a component fragment whose list lives in the parent file.
      if (el.parent === null) continue;
      // Anything opaque above us may be the list: <List><li/></List>, <template>, <slot>.
      if (
        closestAncestor(
          el,
          (a) => isComponent(a) || a.tagLower === 'template' || a.tagLower === 'slot',
        ) !== undefined
      ) {
        continue;
      }
      // Look at the whole ancestor chain, not just the parent. Unclosed <li> and <tr>
      // tags are legal HTML and make the tolerant parser nest siblings; if a list is
      // anywhere above us the markup is probably fine and we stay quiet.
      if (
        closestAncestor(el, (a) => LIST_TAGS.has(a.tagLower) || hasRole(a, 'list')) !== undefined
      ) {
        continue;
      }

      const parent = el.parent;
      out.push(
        ctx.report({
          ruleId: orphanListItem.id,
          wcag: orphanListItem.wcag,
          level: orphanListItem.level,
          severity: orphanListItem.severity,
          start: el.openStart,
          end: el.openEnd,
          message:
            '<li> is inside <' + parent.tag + '> with no <ul>, <ol> or <menu> above it.',
          impact:
            'Without a list parent there is no list to announce: the user hears the ' +
            'text with no "list, N items" boundary and no way to jump between items, ' +
            'so a set of related options reads as one undifferentiated run of prose.',
          fix: advice(
            'review',
            'Wrap these items in a <ul> or <ol>.',
            'Enclose this <li> and its siblings in a <ul> (unordered) or <ol> (where ' +
              'the sequence matters).',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Table model, shared by A11Y-DOC-009, 010 and 011
// ---------------------------------------------------------------------------

interface Cell {
  readonly el: Element;
  readonly row: number;
  readonly col: number;
  readonly header: boolean;
}

interface TableModel {
  readonly rows: readonly Element[];
  readonly cells: readonly Cell[];
  readonly headers: readonly Cell[];
  /** colspan/rowspan anywhere: grid positions can no longer be trusted. */
  readonly hasSpans: boolean;
  /** The explicit id/headers association is in use, which replaces scope entirely. */
  readonly usesHeadersAttr: boolean;
  readonly hasCaption: boolean;
}

function nearestTable(el: Element): Element | undefined {
  return closestAncestor(el, (a) => a.tagLower === 'table' && !isComponent(a));
}

/**
 * Build a grid from source order.
 *
 * Cells are assigned to the last <tr> that opened before them rather than to their
 * parent element, because omitting </tr> and </td> is legal HTML and leaves the
 * tolerant parser with cells nested inside their predecessors.
 */
function modelTable(ctx: RuleContext, table: Element): TableModel {
  const rows: Element[] = [];
  const raw: Element[] = [];
  let hasSpans = false;
  let usesHeadersAttr = false;
  let hasCaption = false;

  for (const el of ctx.markup.elements) {
    if (el.openStart <= table.openStart) continue;
    if (isComponent(el)) continue;
    const tag = el.tagLower;
    if (tag !== 'tr' && tag !== 'td' && tag !== 'th' && tag !== 'caption') continue;
    if (nearestTable(el) !== table) continue;
    if (tag === 'caption') {
      hasCaption = true;
      continue;
    }
    if (tag === 'tr') {
      rows.push(el);
      continue;
    }
    if (hasAttr(el, 'headers')) usesHeadersAttr = true;
    for (const span of ['colspan', 'rowspan']) {
      const v = getAttr(el, span);
      if (v !== undefined && (v.value === null || v.value.trim() !== '1')) hasSpans = true;
    }
    raw.push(el);
  }

  const cells: Cell[] = [];
  let rowIdx = -1;
  let colIdx = 0;
  let nextRow = 0;
  for (const el of raw) {
    while (nextRow < rows.length && (rows[nextRow] as Element).openStart < el.openStart) {
      nextRow++;
      rowIdx++;
      colIdx = 0;
    }
    cells.push({ el, row: Math.max(rowIdx, 0), col: colIdx, header: el.tagLower === 'th' });
    colIdx++;
  }

  return {
    rows,
    cells,
    headers: cells.filter((c) => c.header),
    hasSpans,
    usesHeadersAttr,
    hasCaption,
  };
}

function isPresentationTable(table: Element): boolean {
  return hasRole(table, 'presentation', 'none');
}

// ---------------------------------------------------------------------------
// A11Y-DOC-009 — table without headers
// ---------------------------------------------------------------------------

const tableHasHeaders: Rule = {
  id: 'A11Y-DOC-009',
  title: 'Table has no header cells',
  wcag: ['1.3.1'],
  level: 'A',
  severity: 'warning',
  summary: 'A data table needs <th>; a layout table needs role="presentation".',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const table of ctx.markup.elements) {
      if (table.tagLower !== 'table' || isComponent(table)) continue;
      if (isPresentationTable(table) || hasUnreadableAttrs(ctx, table)) continue;
      const model = modelTable(ctx, table);
      if (model.headers.length > 0) continue;
      // Rows generated from data leave no literal cells here; with nothing to look at
      // we cannot tell a headerless table from one whose <th>s are in a loop.
      if (model.cells.length === 0 && model.rows.length === 0) continue;
      // The explicit id/headers association names the header cells another way.
      if (model.usesHeadersAttr) continue;
      if (ctx.markup.elements.some((e) => nearestTable(e) === table && hasRole(e, 'columnheader', 'rowheader'))) {
        continue;
      }

      out.push(
        ctx.report({
          ruleId: tableHasHeaders.id,
          wcag: tableHasHeaders.wcag,
          level: tableHasHeaders.level,
          severity: tableHasHeaders.severity,
          start: table.openStart,
          end: table.openEnd,
          message: 'This <table> has no <th> cells and no role="presentation".',
          impact:
            'Announced as a data table, every cell is read as a bare value with no ' +
            'header before it — "42", "42", "42" down a column with no idea what is ' +
            'being counted. If the table is really a layout grid, the user is forced ' +
            'through row and column announcements for a structure that means nothing.',
          fix: advice(
            'review',
            'Mark the header cells, or mark the table as presentational.',
            'If this is data, change the heading cells in the first row (and/or the ' +
              'first cell of each row) from <td> to <th> and give them scope. If it is ' +
              'only being used for layout, add role="presentation" — and prefer CSS ' +
              'grid or flexbox instead.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-010 — th without scope in a cross table
// ---------------------------------------------------------------------------

const headerScope: Rule = {
  id: 'A11Y-DOC-010',
  title: 'Header cell has no scope',
  wcag: ['1.3.1'],
  level: 'A',
  severity: 'warning',
  summary: 'In a table with both row and column headers, every <th> needs scope.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const table of ctx.markup.elements) {
      if (table.tagLower !== 'table' || isComponent(table)) continue;
      if (isPresentationTable(table)) continue;
      const model = modelTable(ctx, table);
      // scope is only load-bearing when a cell sits under a column header *and* beside
      // a row header. A single header strip is unambiguous to every screen reader.
      const hasColumnHeaders = model.headers.some((c) => c.row === 0);
      const hasRowHeaders = model.headers.some((c) => c.row > 0 && c.col === 0);
      if (!hasColumnHeaders || !hasRowHeaders) continue;
      // id/headers is the stronger association and makes scope redundant.
      if (model.usesHeadersAttr) continue;

      for (const cell of model.headers) {
        if (boundAttrOf(cell.el, 'scope') !== undefined) continue;
        if (hasAttr(cell.el, 'role')) continue;
        if (hasUnreadableAttrs(ctx, cell.el)) continue;

        const direction = cell.row === 0 ? 'col' : cell.col === 0 ? 'row' : undefined;
        // Spans move cells off their source-order grid position, so we can no longer
        // claim the direction is forced by where the cell sits.
        const patchable = direction !== undefined && !model.hasSpans;

        let fix: Fix;
        if (patchable && direction !== undefined) {
          fix = {
            safety: 'review',
            edits: [
              addAttribute(
                ctx,
                cell.el,
                'scope="' + direction + '"',
                'add scope="' + direction + '"',
              ),
            ],
            description:
              'Add scope="' + direction + '". This <th> is ' +
              (direction === 'col'
                ? 'in the header row, so it labels the column below it.'
                : 'the first cell of its row, so it labels the row beside it.'),
          };
        } else {
          fix = advice(
            'review',
            'Declare what this header cell labels.',
            'Add scope="col", scope="row", or the colgroup/rowgroup form. This cell is ' +
              'at row ' + (cell.row + 1) + ', column ' + (cell.col + 1) +
              (model.hasSpans
                ? ', and the table uses colspan/rowspan, so only a human can say which ' +
                  'cells it covers.'
                : ', which does not by itself say which direction it labels.'),
          );
        }

        out.push(
          ctx.report({
            ruleId: headerScope.id,
            wcag: headerScope.wcag,
            level: headerScope.level,
            severity: headerScope.severity,
            start: cell.el.openStart,
            end: cell.el.openEnd,
            message:
              '<th> at row ' + (cell.row + 1) + ', column ' + (cell.col + 1) +
              ' has no scope, and this table has both row and column headers.',
            impact:
              'With headers running two ways the browser has to guess which one belongs ' +
              'to a cell. A screen reader then reads the wrong header — the user hears ' +
              '"Q3, 41" for a cell that is actually "Berlin, 41" — and the number is ' +
              'attached to the wrong thing without any sign that it went wrong.',
            fix,
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-011 — data table without a caption
// ---------------------------------------------------------------------------

const tableHasCaption: Rule = {
  id: 'A11Y-DOC-011',
  title: 'Data table has no caption',
  wcag: [],
  level: 'A',
  severity: 'warning',
  summary: 'A data table should be named by a <caption> or aria-label.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const table of ctx.markup.elements) {
      if (table.tagLower !== 'table' || isComponent(table)) continue;
      if (isPresentationTable(table)) continue;
      if (hasUnreadableAttrs(ctx, table)) continue;
      if (hasAriaName(table) || hasAttr(table, 'title')) continue;
      const model = modelTable(ctx, table);
      if (model.hasCaption) continue;
      // Only ask for a caption once we know this is a real data table. A table with no
      // headers at all is already reported by A11Y-DOC-009, and naming a layout table
      // is not the fix it needs.
      if (model.headers.length === 0) continue;

      out.push(
        ctx.report({
          ruleId: tableHasCaption.id,
          wcag: tableHasCaption.wcag,
          level: tableHasCaption.level,
          severity: tableHasCaption.severity,
          start: table.openStart,
          end: table.openEnd,
          message: 'This data table has no <caption> and no aria-label.',
          impact:
            'A screen reader lists the tables on a page so the user can pick one. ' +
            'Unnamed, they all appear as "table" — and a user who lands inside one ' +
            'hears the cells with no statement of what the table is about.',
          // The caption is a sentence about the data. We do not know what the data is.
          fix: advice(
            'manual',
            'Name the table with a <caption>.',
            'Add a <caption> as the first child of the <table>, saying what the table ' +
              'contains, e.g. "Monthly revenue by region, 2024". Use aria-label instead ' +
              'only if the name must not be visible.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-012 / 013 — main landmark
// ---------------------------------------------------------------------------

function mainLandmarks(ctx: RuleContext): Element[] {
  return ctx.markup.elements.filter(
    (el) => (el.tagLower === 'main' && !isComponent(el)) || hasRole(el, 'main'),
  );
}

const hasMainLandmark: Rule = {
  id: 'A11Y-DOC-012',
  title: 'Page has no main landmark',
  wcag: [],
  level: 'A',
  severity: 'warning',
  summary: 'A page should wrap its primary content in <main>.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    if (!isDocument(ctx)) return [];
    // <Main />, <slot /> and <template> can all supply the landmark from elsewhere.
    if (hasOpaqueContent(ctx)) return [];
    if (mainLandmarks(ctx).length > 0) return [];
    const anchor = documentAnchor(ctx);
    if (anchor === undefined) return [];

    return [
      ctx.report({
        ruleId: hasMainLandmark.id,
        wcag: hasMainLandmark.wcag,
        level: hasMainLandmark.level,
        severity: hasMainLandmark.severity,
        start: anchor.openStart,
        end: anchor.openEnd,
        message: 'The document has no <main> element and nothing with role="main".',
        impact:
          'Screen readers offer "jump to main content" as a landmark command; with no ' +
          'main landmark it is missing, so on every page load the user has to tab past ' +
          'the entire header and navigation again before reaching the content.',
        fix: advice(
          'review',
          'Wrap the page\'s primary content in <main>.',
          'Put a single <main> around the content unique to this page — not the ' +
            'header, nav or footer, which belong in their own landmarks.',
        ),
      }),
    ];
  },
};

const oneMainLandmark: Rule = {
  id: 'A11Y-DOC-013',
  title: 'Page has more than one main landmark',
  wcag: ['1.3.1'],
  level: 'A',
  severity: 'error',
  summary: 'A document may contain only one <main>.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    // Document-gated on purpose: `{ok ? <main>…</main> : <main>…</main>}` in a
    // component renders exactly one main, and only the document tells us which
    // branches can coexist.
    if (!isDocument(ctx)) return [];
    const mains = mainLandmarks(ctx);
    if (mains.length < 2) return [];

    const out: Violation[] = [];
    const first = mains[0] as Element;
    for (let i = 1; i < mains.length; i++) {
      const extra = mains[i] as Element;
      out.push(
        ctx.report({
          ruleId: oneMainLandmark.id,
          wcag: oneMainLandmark.wcag,
          level: oneMainLandmark.level,
          severity: oneMainLandmark.severity,
          start: extra.openStart,
          end: extra.openEnd,
          message:
            'This is main landmark number ' + (i + 1) + ' in the document; the first is ' +
            'on line ' + lineOf(ctx, first.openStart) + '.',
          impact:
            '"Jump to main content" stops at the first one. Everything in the second ' +
            'main is announced as primary content too, so the user has no way to tell ' +
            'which region actually holds the page\'s content and may never reach the ' +
            'other one at all.',
          fix: advice(
            'review',
            'Keep one <main> and give the others a fitting landmark.',
            'Choose the region that holds this page\'s primary content and leave that ' +
              'as <main>; the others are usually <aside>, <section aria-label="…"> or ' +
              'a plain <div>.',
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-014 — iframe title
// ---------------------------------------------------------------------------

const frameTitle: Rule = {
  id: 'A11Y-DOC-014',
  title: 'Frame has no title',
  wcag: ['2.4.1', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'Every <iframe> needs a title describing what it contains.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (isComponent(el)) continue;
      if (el.tagLower !== 'iframe' && el.tagLower !== 'frame') continue;
      if (isAriaHidden(el)) continue;

      // `:title="t"`, `title={t}` and `{...props}` all set a title we cannot read.
      // Reporting one of those as missing and inserting a literal beside it produces a
      // duplicate attribute in code that was already correct.
      const attr = boundAttrOf(el, 'title');
      if (attr !== undefined && (attr.nameLower !== 'title' || attr.dynamic || attr.quote === '{')) {
        continue;
      }
      if (attr === undefined && (hasAriaName(el) || hasUnreadableAttrs(ctx, el))) continue;
      const value = attr?.value ?? null;
      if (attr !== undefined && value !== null && value.trim() !== '') continue;

      const placeholder = TODO_MARKER + ': describe what this frame contains';
      // A frame title is human-meaningful text. We will not invent it — we mark the
      // spot with something that fails CI and is obviously not a real title.
      const fix: Fix =
        attr === undefined
          ? {
              safety: 'manual',
              edits: [
                addAttribute(
                  ctx,
                  el,
                  'title=' + JSON.stringify(placeholder),
                  'add a title placeholder to <' + el.tag + '>',
                ),
              ],
              description:
                'Insert a title containing a TODO marker. Only someone who knows what ' +
                'is embedded here can name it, and a wrong name is worse than none.',
            }
          : {
              safety: 'manual',
              edits: [
                {
                  start: attr.valueStart,
                  end: attr.valueEnd,
                  replacement: JSON.stringify(placeholder),
                  label: 'mark the empty title for a human',
                },
              ],
              description:
                'Replace the empty title with a TODO marker so the frame is named by a ' +
                'person rather than by a checker.',
            };

      out.push(
        ctx.report({
          ruleId: frameTitle.id,
          wcag: frameTitle.wcag,
          level: frameTitle.level,
          severity: frameTitle.severity,
          start: el.openStart,
          end: el.openEnd,
          message:
            attr === undefined
              ? '<' + el.tag + '> has no title attribute.'
              : '<' + el.tag + '> has an empty title attribute.',
          impact:
            'The frame is announced only as "frame", and its content is a whole ' +
            'separate document the user has to enter to identify. Faced with three ' +
            'unnamed frames they must step into each one and read it to find out ' +
            'whether it is the video, the map or the advert.',
          fix,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-015 — skip link
// ---------------------------------------------------------------------------

/** An in-page link that plausibly bypasses the navigation. */
function isSkipLink(ctx: RuleContext, a: Element, mainId: string | undefined, navStart: number): boolean {
  const href = literalAttr(a, 'href') ?? literalAttr(a, 'xlink:href');
  if (href === undefined || !href.startsWith('#') || href.length < 2) return false;
  const target = href.slice(1);
  if (mainId !== undefined && target === mainId) return true;
  if (/\b(skip|jump)\b/i.test(textOf(a))) return true;
  // An in-page link placed before the navigation is a skip link by position.
  return a.openStart < navStart;
}

const skipLink: Rule = {
  id: 'A11Y-DOC-015',
  title: 'No way to skip the navigation',
  wcag: ['2.4.1'],
  level: 'A',
  severity: 'info',
  summary: 'A page whose nav precedes its main content should offer a skip link.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    // Deliberately narrow. This is a claim about the whole rendered page, so it only
    // runs on a literal document: real <html>/<body>, no components or slots that
    // could be supplying the skip link from somewhere we cannot see.
    if (!isDocument(ctx)) return [];
    if (hasOpaqueContent(ctx)) return [];

    const nav = ctx.markup.elements.find(
      (el) => (el.tagLower === 'nav' && !isComponent(el)) || hasRole(el, 'navigation'),
    );
    if (nav === undefined) return [];
    const main = mainLandmarks(ctx)[0];
    if (main === undefined) return [];
    if (nav.openStart >= main.openStart) return [];
    // A nav nested inside main is page content, not the site navigation being bypassed.
    if (closestAncestor(nav, (a) => a === main) !== undefined) return [];

    const mainId = literalAttr(main, 'id');
    const anchors = ctx.markup.elements.filter(
      (el) => el.tagLower === 'a' && !isComponent(el) && el.openStart < main.openStart,
    );
    if (anchors.some((a) => isSkipLink(ctx, a, mainId, nav.openStart))) return [];

    return [
      ctx.report({
        ruleId: skipLink.id,
        wcag: skipLink.wcag,
        level: skipLink.level,
        severity: skipLink.severity,
        start: nav.openStart,
        end: nav.openEnd,
        message:
          'This <' + nav.tag + '> comes before the main content and the page has no ' +
          'in-page link that bypasses it.',
        impact:
          'A keyboard-only user tabs through every link in this navigation on every ' +
          'page of the site before reaching the content. On a menu of thirty links ' +
          'that is thirty keystrokes, repeated on each page load.',
        fix: advice(
          'manual',
          'Add a skip link as the first focusable element.',
          'Put <a href="#' + (mainId ?? 'main-content') + '">Skip to main content</a> ' +
            'at the very start of the <body>' +
            (mainId === undefined ? ', and give the <main> id="main-content"' : '') +
            '. Keep it visible on focus rather than permanently hidden.',
        ),
      }),
    ];
  },
};

// ---------------------------------------------------------------------------
// A11Y-DOC-016 — accessibility overlay widget
// ---------------------------------------------------------------------------

/**
 * Scripts and stylesheets whose whole product is a switch that restyles the page.
 *
 * `bvi` matters most by volume: bvi.js — «Кнопка "Версия для слабовидящих"» — is
 * installed on a very large number of Russian institutional sites, usually as the
 * entire answer to ГОСТ Р 52872-2019. The Western vendors are here for the same
 * reason: one control, applied over markup nobody changed.
 *
 * Matched as substrings of the URL, so a version or a CDN prefix does not defeat
 * them. The `bvi` entries all carry a dot or a slash on purpose — bare `bvi` appears
 * inside `webvisor`, which is on a large fraction of Russian sites and has nothing to
 * do with this.
 */
const OVERLAY_ASSETS = [
  'accessibe',
  'acsbapp',
  'userway',
  'audioeye',
  'equalweb',
  'allyable',
  'accessiway',
  'maxaccess',
  'mibok',
];

/**
 * The one vendor whose name is also a Russian word fragment.
 *
 * slabovid.ru is a real overlay vendor and its script must still be found. But bare
 * `slabovid` as a substring also matches `dlyaslabovidyashchikh` — "для слабовидящих" —
 * which is the path every Russian institution puts its low-vision page at. A site's own
 * `<link rel="canonical" href="/dostupnyy-muzey/dlyaslabovidyashchikh/">` was therefore
 * evidence that it had installed a widget, which is a finding that invents the thing it
 * reports. Matched by domain, the same way BVI_ASSET is bounded so it cannot match
 * `webvisor`.
 */
const SLABOVID_ASSET = /slabovid\.ru/;

/**
 * `rel` values on a <link> that actually load code or style into the page.
 *
 * Anything else — canonical, alternate, icon, manifest, preconnect — is metadata, and its
 * href is a page address rather than an asset the browser executes.
 */
const LOADING_REL = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch']);

/**
 * The bvi family, whose filenames vary — bvi.js, bvi.min.js, bvi.min.css, js/bvi/init.js.
 * A bare 'bvi' substring cannot be used: 'webvisor' contains one, and Yandex Metrica puts
 * webvisor on a large fraction of Russian sites. Requiring a dot, dash or slash after it
 * separates the two.
 */
const BVI_ASSET = /bvi[.\-/]/;

/**
 * Class and id markers left by the same widgets in the page's own markup — the panel
 * they inject, or a button a site author wired up by hand.
 *
 * Narrower than the asset list on purpose: these are matched against every element in
 * the file, so a loose token here would fire on ordinary pages. Each is a name only an
 * overlay uses. `slabovid` covers the transliterated classes people write themselves
 * (`gim-slabovidenie-btn` on shm.ru, for one).
 */
const OVERLAY_MARKUP = ['bvi-open', 'bvi-panel', 'bvi-block', 'acsb-trigger', 'userway_', 'slabovid'];

/** Link, button or input text offering to restyle the page for low vision. */
const OVERLAY_TEXT =
  /слабовидящ|для\s+инвалидов\s+по\s+зрению|специальн[а-яё]*\s+верси|accessibility\s+(?:menu|widget|toolbar)/i;

/**
 * A control's label is short. Capping the text we test is what separates the switch
 * from an article that happens to mention слабовидящие readers — and it also stops a
 * handler on a large wrapper from dragging half the page into the match.
 */
const MAX_LABEL = 120;

const OVERLAY_CLICK = ['onclick', '@click', 'v-on:click', 'on:click', 'x-on:click'];

const overlayWidget: Rule = {
  id: 'A11Y-DOC-016',
  title: 'Accessibility overlay on the page',
  // Deliberately no criterion. Having an overlay violates nothing; what it does is give
  // the owner of the site a reason to believe the criteria are already met.
  wcag: [],
  level: 'A',
  severity: 'info',
  summary: 'A widget that restyles the page for low vision, which is not the same as fixing it.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    const seen = new Set<number>();

    const report = (el: Element, what: string): void => {
      if (seen.has(el.openStart)) return;
      seen.add(el.openStart);
      out.push(
        ctx.report({
          ruleId: overlayWidget.id,
          wcag: overlayWidget.wcag,
          level: overlayWidget.level,
          severity: overlayWidget.severity,
          start: el.openStart,
          end: el.openEnd,
          message: `${what} restyles the page for low vision.`,
          impact:
            'It changes size, colour and spacing, which genuinely helps some people. It ' +
            'does not change the markup a screen reader reads: an image with no alt has ' +
            'no alt at any font size, a field labelled only by its placeholder is still ' +
            'unlabelled, and a table with no header cells is still a stream of numbers. ' +
            'Everything else in this report is something the switch does not address.',
          fix: advice(
            'manual',
            'Keep it if people use it, and fix the markup underneath as well.',
            'Nothing here says remove it — a font-size and contrast control is useful on ' +
              'its own. It is not a substitute for the rest of this report, and the two ' +
              'are routinely sold as if they were the same thing: in 2025 the US Federal ' +
              'Trade Commission ordered an overlay vendor to pay $1 million over claims ' +
              'that its widget made any website conform to WCAG.',
          ),
        }),
      );
    };

    for (const el of ctx.markup.elements) {
      if (isComponent(el)) continue;

      if (el.tagLower === 'script' || el.tagLower === 'link') {
        // Only a <link> that loads code or style can be an overlay. Every Russian
        // institution's low-vision page lives at a path like /dlyaslabovidyashchikh/, so
        // reading `href` off any <link> at all made a site's own
        // `<link rel="canonical">` evidence that it had installed a widget — a finding
        // that invents the thing it reports. BVI_ASSET was written as /bvi[.\-\/]/
        // precisely so it would not match `webvisor`; the same care had not been taken
        // here.
        if (el.tagLower === 'link' && !LOADING_REL.has((literalAttr(el, 'rel') ?? '').trim().toLowerCase())) {
          continue;
        }
        const url = (literalAttr(el, 'src') ?? literalAttr(el, 'href') ?? '').toLowerCase();
        const hit =
          url === ''
            ? undefined
            : (OVERLAY_ASSETS.find((m) => url.includes(m)) ??
              BVI_ASSET.exec(url)?.[0] ??
              SLABOVID_ASSET.exec(url)?.[0]);
        if (hit !== undefined) report(el, `A <${el.tagLower}> whose URL contains "${hit}"`);
        continue;
      }

      const names = `${literalAttr(el, 'class') ?? literalAttr(el, 'className') ?? ''} ${
        literalAttr(el, 'id') ?? ''
      }`.toLowerCase();
      const marker = names.trim() === '' ? undefined : OVERLAY_MARKUP.find((m) => names.includes(m));
      if (marker !== undefined) {
        report(el, `This <${el.tagLower}>, marked "${marker}",`);
        continue;
      }

      // Only things that act as controls. A paragraph about services for readers with
      // low vision is not a switch, and reporting it would be exactly the kind of
      // keyword matching this tool is written against.
      const control =
        el.tagLower === 'a' ||
        el.tagLower === 'button' ||
        el.tagLower === 'input' ||
        el.attrs.some((a) => OVERLAY_CLICK.includes(a.nameLower));
      if (!control) continue;

      // `value` and `alt` are here for <input type="submit"> and <input type="image">,
      // which is how a Drupal or Bitrix theme usually renders the switch.
      const label = [
        el.tagLower === 'input' ? '' : textOf(el),
        literalAttr(el, 'aria-label') ?? '',
        literalAttr(el, 'title') ?? '',
        literalAttr(el, 'value') ?? '',
        literalAttr(el, 'alt') ?? '',
      ]
        .filter((s) => s !== '' && s.length <= MAX_LABEL)
        .join(' ');
      if (OVERLAY_TEXT.test(label)) report(el, `This <${el.tagLower}>`);
    }

    return out;
  },
};

export const RULES: readonly Rule[] = [
  htmlHasLang,
  htmlLangValid,
  documentHasTitle,
  headingOrder,
  singleH1,
  uniqueIds,
  listChildren,
  orphanListItem,
  tableHasHeaders,
  headerScope,
  tableHasCaption,
  hasMainLandmark,
  oneMainLandmark,
  frameTitle,
  skipLink,
  overlayWidget,
];
