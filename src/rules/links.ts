/**
 * Links and navigation.
 *
 * A link is the one control whose whole job is to say where it goes. Almost every
 * failure in this family is a failure of *naming*, and a name is exactly the thing this
 * tool refuses to invent — so most rules here emit advice or a marker rather than a
 * patch. The two exceptions are mechanical: `rel="noopener"` has one correct answer, and
 * merging it into an existing `rel` has one correct answer that a human should still see.
 *
 * Everything here is deliberately conservative about dynamic markup. `<a href={url}>`,
 * `<a :href="url">`, `{label}` children and `<slot />` all mean the real name or
 * destination is decided at runtime, and a rule that guesses at those produces noise in
 * exactly the codebases that most need signal.
 */

import type { Attr, Element } from '../parse/markup.js';
import type { Edit, Rule, RuleContext, Violation } from '../types.js';
import { TODO_MARKER } from '../types.js';
import { getAttr, hasAttr, textOf } from '../parse/markup.js';

/* ------------------------------------------------------------------ helpers */

const JSX_FILE = /\.(?:jsx|tsx|ts|js|mjs|cjs|mts|cts)$/i;

function isJsxFile(ctx: RuleContext): boolean {
  return JSX_FILE.test(ctx.file);
}

/**
 * A tag that names a component rather than an HTML element. Legacy HTML is often written
 * fully uppercase (`<IMG>`), so only a *mixed* case tag — or a dotted one — is treated as
 * a component. Getting this wrong in the safe direction costs a missed finding; getting
 * it wrong the other way means reasoning about HTML semantics an author never wrote.
 */
function isComponentTag(tag: string): boolean {
  const first = tag[0];
  if (first === undefined || first < 'A' || first > 'Z') return false;
  return tag.includes('.') || tag !== tag.toUpperCase();
}

/** `<a>` written as an anchor. In JSX `<A>` is a component, never an anchor. */
function isAnchor(el: Element, jsx: boolean): boolean {
  if (el.tagLower !== 'a') return false;
  return !jsx || el.tag === 'a';
}

/** `<a>` or `<area>` — the two elements that carry `target`. */
function isLinkLike(el: Element, jsx: boolean): boolean {
  if (isAnchor(el, jsx)) return true;
  return el.tagLower === 'area' && (!jsx || el.tag === 'area');
}

interface AttrRead {
  readonly present: boolean;
  /** The value is an expression, so its text is unknowable at build time. */
  readonly dynamic: boolean;
  /** Literal value; always '' when `dynamic`. */
  readonly value: string;
}

const ABSENT: AttrRead = { present: false, dynamic: false, value: '' };

function readAttr(el: Element, name: string): AttrRead {
  const a = getAttr(el, name);
  if (a === undefined) return ABSENT;
  const dynamic = a.dynamic || a.quote === '{';
  return { present: true, dynamic, value: dynamic ? '' : (a.value ?? '') };
}

/** Like `readAttr`, but also sees Vue/Alpine bound forms (`:href`, `v-bind:href`). */
function readBindable(el: Element, name: string): AttrRead {
  const direct = readAttr(el, name);
  if (direct.present) return direct;
  const lower = name.toLowerCase();
  for (const a of el.attrs) {
    if (a.nameLower === `:${lower}` || a.nameLower === `v-bind:${lower}` || a.nameLower === `x-bind:${lower}`) {
      return { present: true, dynamic: true, value: '' };
    }
  }
  return ABSENT;
}

function walk(el: Element, visit: (child: Element) => void): void {
  for (const child of el.children) {
    visit(child);
    walk(child, visit);
  }
}

/** Single `{...}` group. No nested quantifier, so it cannot backtrack catastrophically. */
const EXPRESSION = /\{[^{}]*\}/g;

/**
 * True when the element's children could supply a name we cannot read: a JSX/Vue
 * expression, a slot, or a component whose rendered output is unknown here.
 */
function hasOpaqueContent(el: Element): boolean {
  const src = el.innerSource;
  if (src.includes('<slot') || src.includes('<Slot')) return true;
  // Every group, not just the first: `{}{label}` opens with an empty one, and stopping
  // there would call a link with a runtime name "empty" and mark it for a TODO.
  for (const m of src.matchAll(EXPRESSION)) {
    if (m[0].slice(1, -1).trim() !== '') return true;
  }
  let component = false;
  walk(el, (child) => {
    if (isComponentTag(child.tag)) component = true;
  });
  return component;
}

interface LinkName {
  /** Literal accessible name we can read. Empty when there is none. */
  readonly text: string;
  /** Something names this link but we cannot read it — never report on the name. */
  readonly opaque: boolean;
}

/**
 * The accessible name, to the extent source can tell us. `aria-label` wins over content,
 * matching the accname algorithm closely enough for the judgements made here.
 */
function nameOf(el: Element): LinkName {
  if (hasAttr(el, 'aria-labelledby')) return { text: '', opaque: true };
  const label = readAttr(el, 'aria-label');
  if (label.present) {
    if (label.dynamic) return { text: '', opaque: true };
    return { text: label.value.trim(), opaque: false };
  }
  if (hasOpaqueContent(el)) return { text: '', opaque: true };
  return { text: textOf(el), opaque: false };
}

/** Strip accents and surrounding punctuation so `Read more »` matches `read more`. */
function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .trim();
}

/**
 * Offset of the point just before the closing `>` of the opening tag, or `null` when the
 * tag is not actually terminated in the source.
 *
 * `openEnd` is one past the `>`, so `openEnd - 1` lands before it for `<img src=x>` and
 * `<a ...>` alike; a trailing slash needs one more, so `<img src=x />` inserts before the
 * `/`. The slash is tested on the character rather than trusted from `selfClosing`,
 * because the parser also reports `selfClosing` from a recovery path.
 *
 * The `>` check is the important one: on an unterminated tag the parser sets `openEnd` to
 * the end of its scan window, and inserting there would drop an attribute into the middle
 * of unrelated source.
 */
function attrInsertPoint(ctx: RuleContext, el: Element): number | null {
  if (el.openEnd < 2 || ctx.source[el.openEnd - 1] !== '>') return null;
  // An unterminated quote makes the parser run the value on past the real end of the tag,
  // so the `>` found above belongs to something else entirely. Write nothing into a tag
  // we have not read cleanly.
  if (el.attrs.some((a) => a.value !== null && valueSpan(ctx, el, a) === null)) return null;
  return el.openEnd - (ctx.source[el.openEnd - 2] === '/' ? 2 : 1);
}

/** Attribute text with a leading space only when the character before it needs one. */
function spacedAttr(ctx: RuleContext, at: number, attr: string): string {
  const before = ctx.source[at - 1];
  const spaced = before === ' ' || before === '\t' || before === '\n' || before === '\r' || before === '\f';
  return spaced ? attr : ` ${attr}`;
}

/**
 * The span of an attribute's value *including its quotes*, or `null` when the source does
 * not close it. An unterminated quote makes the parser report a value that runs to the end
 * of the tag-scan window, and replacing that range would swallow real source.
 */
function valueSpan(ctx: RuleContext, el: Element, attr: Attr): { start: number; end: number } | null {
  if (attr.value === null) return null;
  if (attr.valueStart < el.openStart || attr.valueEnd > el.openEnd) return null;
  if (attr.quote === '"' || attr.quote === "'") {
    if (ctx.source[attr.valueStart] !== attr.quote) return null;
    if (attr.valueEnd - attr.valueStart < 2 || ctx.source[attr.valueEnd - 1] !== attr.quote) return null;
  }
  return { start: attr.valueStart, end: attr.valueEnd };
}

/** A literal attribute value rendered as a double-quoted attribute value. */
function quoteValue(value: string): string | null {
  // No escape syntax exists inside a markup attribute value, so a value carrying the
  // quote character cannot be re-quoted; the caller must decline rather than corrupt it.
  if (value.includes('"')) return null;
  return `"${value}"`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function elementSpan(el: Element): { start: number; end: number } {
  return { start: el.openStart, end: el.openEnd };
}

/** Every set of siblings in the file, so "adjacent" can be asked without a DOM. */
function siblingGroups(ctx: RuleContext): Element[][] {
  const groups: Element[][] = [ctx.markup.roots.slice()];
  for (const el of ctx.markup.elements) {
    if (el.children.length > 0) groups.push(el.children);
  }
  return groups;
}

/** Primary subtag of `<html lang>`, lowercased. Defaults to English. */
function documentLanguage(ctx: RuleContext): string {
  for (const el of ctx.markup.elements) {
    if (el.tagLower !== 'html') continue;
    const lang = readAttr(el, 'lang');
    if (!lang.present || lang.dynamic) return 'en';
    const primary = lang.value.trim().toLowerCase().split(/[-_]/)[0];
    return primary !== undefined && primary.length > 0 ? primary : 'en';
  }
  return 'en';
}

/* --------------------------------------------------------------- vocabulary */

/**
 * Link text that carries no meaning when read out of context. Stored accent-free and
 * lowercase; compared against `normalizeText` output, so the two agree by construction.
 */
const GENERIC_LINK_TEXT: Readonly<Record<string, readonly string[]>> = {
  en: [
    'click here', 'click', 'click this', 'click this link', 'here', 'read more', 'more',
    'learn more', 'see more', 'view more', 'more info', 'more information', 'read this',
    'this', 'this link', 'link', 'download', 'continue', 'continue reading', 'read on',
    'details', 'full story', 'go',
  ],
  es: [
    'haga clic aqui', 'haz clic aqui', 'clic aqui', 'pincha aqui', 'aqui', 'leer mas',
    'mas', 'mas informacion', 'ver mas', 'saber mas', 'descargar', 'continuar',
    'seguir leyendo', 'este enlace', 'enlace', 'este',
  ],
  fr: [
    'cliquez ici', 'cliquer ici', 'ici', 'en savoir plus', 'plus', 'lire la suite',
    'voir plus', 'telecharger', 'continuer', 'ce lien', 'lien', 'suite',
  ],
  de: [
    'hier klicken', 'klicken sie hier', 'hier', 'mehr', 'mehr erfahren',
    'mehr informationen', 'weiterlesen', 'weiter', 'herunterladen', 'download',
    'dieser link', 'link',
  ],
  pt: [
    'clique aqui', 'aqui', 'leia mais', 'ler mais', 'mais', 'saiba mais', 'ver mais',
    'baixar', 'descarregar', 'continuar', 'este link', 'link',
  ],
  it: [
    'clicca qui', 'qui', 'leggi di piu', 'di piu', 'piu', 'scopri di piu', 'vedi altro',
    'scarica', 'continua', 'questo link', 'link',
  ],
  nl: [
    'klik hier', 'hier', 'lees meer', 'meer', 'meer informatie', 'meer info',
    'downloaden', 'download', 'verder', 'deze link', 'link',
  ],
  // Only ever consulted on a page that declares lang="ru", like every other list here.
  // «Подробнее» is the «read more» of the Russian web and sits under most news cards on
  // most institutional sites; a screen-reader user listing the links then hears it forty
  // times with nothing to tell them apart.
  //
  // normalizeText decomposes and strips combining marks, so «ё» arrives as «е»: the
  // spellings written here are the post-normalisation ones, and «ещё» would never match.
  ru: [
    'подробнее', 'подробно', 'подробная информация', 'читать далее', 'читать дальше',
    'читать', 'читать полностью', 'далее', 'дальше', 'здесь', 'тут', 'сюда',
    'нажмите здесь', 'нажмите сюда', 'кликните здесь', 'ссылка', 'эта ссылка',
    'по ссылке', 'перейти', 'открыть', 'смотреть', 'посмотреть', 'скачать',
    'загрузить', 'узнать больше', 'больше', 'еще', 'продолжение', 'ознакомиться',
  ],
};

/**
 * Phrases that already warn a user that the link leaves the current window, by language.
 *
 * Keyed rather than pooled, and the key decides whether the rule runs at all. A flat list
 * meant that on a Greek page every `target="_blank"` link was reported as unannounced —
 * including the one whose text ends «ανοίγει σε νέα καρτέλα», which says exactly the thing
 * the finding accuses it of not saying. The tool had no Greek, so what it actually knew
 * was nothing, and it reported that as a fault.
 *
 * A language absent from this table is a language this rule cannot read, so it says
 * nothing there. That loses real findings on those pages. It is the trade this tool makes
 * everywhere, and the alternative — guessing from an alphabet — is how the placeholder-alt
 * rule invented 649 findings on one Russian site.
 */
const NEW_WINDOW_HINTS: Readonly<Record<string, readonly string[]>> = {
  en: ['new window', 'new tab', 'opens in', 'opens a new', 'external link', 'external site'],
  es: ['nueva ventana', 'nueva pestana', 'se abre en', 'enlace externo'],
  fr: ['nouvelle fenetre', 'nouvel onglet', 'ouvre dans', 'lien externe'],
  de: ['neues fenster', 'neuer tab', 'neuem tab', 'neuem fenster', 'externer link'],
  pt: ['nova janela', 'nova aba', 'abre em', 'link externo'],
  it: ['nuova finestra', 'nuova scheda', 'si apre in', 'link esterno'],
  nl: ['nieuw venster', 'nieuw tabblad', 'opent in', 'externe link'],
  ru: [
    'новом окне', 'новой вкладке', 'новом окно', 'откроется в', 'открывается в',
    'внешняя ссылка', 'внешний сайт', 'другой сайт',
  ],
};

/** Text that is nothing but a web address. `[^\s]+` is linear — no backtracking risk. */
const BARE_URL = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s]+$/i;

/** Every spelling of `rel` a template dialect might use, static form first. */
const REL_ATTR_NAMES = ['rel', ':rel', 'v-bind:rel', 'x-bind:rel'];

const CLICK_HANDLERS = ['onclick', '@click', 'v-on:click', 'on:click', 'x-on:click'];

function hasClickHandler(el: Element): boolean {
  return el.attrs.some((a) => CLICK_HANDLERS.includes(a.nameLower));
}

/** `#`, `javascript:void(0)` and friends: an href that navigates nowhere. */
function isPlaceholderHref(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '#') return true;
  const compact = trimmed.toLowerCase().replace(/\s+/g, '');
  return compact === 'javascript:' || compact === 'javascript:;' || compact.startsWith('javascript:void');
}

/* -------------------------------------------------------------------- rules */

const emptyLink: Rule = {
  id: 'A11Y-LINK-001',
  title: 'Link has no discernible text',
  wcag: ['2.4.4', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'A link whose content is empty, whitespace, or an unlabelled image has no accessible name.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isAnchor(el, jsx)) continue;
      // Without href this is a legacy named anchor, not a control: it needs no name.
      if (!readBindable(el, 'href').present) continue;

      const name = nameOf(el);
      if (name.opaque || name.text.trim() !== '') continue;
      // `title` is a poor accessible name but it is a real one; do not double-report.
      const title = readAttr(el, 'title');
      if (title.present && (title.dynamic || title.value.trim() !== '')) continue;

      let unlabelledImage: Element | null = null;
      let named = false;
      walk(el, (child) => {
        // A label on *any* descendant names the link, not only one on an <img> or <svg>.
        //
        // The walk used to return immediately for every other tag, so
        // `<a><div role="img" aria-label="Менделеев 2026"></div></a>` — the standard way
        // to caption a CSS background image, and what Drupal and Bitrix themes emit
        // everywhere — was reported as having "no text, no aria-label and no labelled
        // content". The third clause was a claim the code never checked. Twenty-eight
        // findings on one university's front page, every one at error severity, and each
        // carrying an edit that --mark-todos would have used to write
        // aria-label="A11YFIX-TODO…" over a link that was already named.
        const label = readAttr(child, 'aria-label');
        if ((label.present && (label.dynamic || label.value.trim() !== '')) || hasAttr(child, 'aria-labelledby')) {
          named = true;
          return;
        }
        if (child.tagLower !== 'img' && child.tagLower !== 'svg') return;
        const alt = readAttr(child, 'alt');
        if (alt.present && (alt.dynamic || alt.value.trim() !== '')) {
          named = true;
          return;
        }
        if (unlabelledImage === null) unlabelledImage = child;
      });
      if (named) continue;

      const span = elementSpan(el);
      if (unlabelledImage !== null) {
        // Two correct fixes exist (alt on the image, or aria-label on the link) and the
        // image family owns the first. Emitting neither keeps the two rules from
        // labelling the same link twice and from fighting over adjacent ranges.
        out.push(
          ctx.report({
            ruleId: emptyLink.id,
            wcag: emptyLink.wcag,
            level: emptyLink.level,
            severity: emptyLink.severity,
            start: span.start,
            end: span.end,
            // An <svg> has no alt attribute in any specification, so telling a developer
            // to add one is advice they cannot follow: they write it, it does nothing,
            // and the fault ships with a tick beside it. The name for inline SVG comes
            // from a child <title> or from aria-label. Reachable on real sites — the
            // Darwin Museum's logo link is `<a href="/"><svg id="logo_svg_top">`.
            message:
              (unlabelledImage as Element).tagLower === 'svg'
                ? 'Link contains only an <svg> with no title or label, so it has no accessible name.'
                : 'Link contains only an image with no alt text, so it has no accessible name.',
            impact:
              'A screen reader announces "link" and then the image file name, or nothing at all, so the only way to find out where the link goes is to follow it and come back.',
            fix: {
              safety: 'manual',
              edits: [],
              description: 'Name the link from the image it contains.',
              advisory:
                (unlabelledImage as Element).tagLower === 'svg'
                  ? 'Put a <title> as the first child of the <svg> describing the link destination (not the drawing), or aria-label on the <a> and aria-hidden="true" on the <svg>. Only someone who knows the destination can write it.'
                  : 'Give the <img> alt text describing the link destination (not the picture), or put aria-label on the <a> and alt="" on the image. Only someone who knows the destination can write it.',
            },
          }),
        );
        continue;
      }

      const markerText = `${TODO_MARKER}: describe this link's destination`;
      // Present here only if it is a literal: a dynamic aria-label reads as opaque above.
      const existingLabel = getAttr(el, 'aria-label');
      const edits: Edit[] = [];
      if (existingLabel !== undefined) {
        // The attribute is already there and empty, so fill it rather than adding a
        // second one: markup keeps the *first* of two identical attributes, so an
        // inserted duplicate would be ignored by every consumer but a human diff reader.
        const labelSpan = valueSpan(ctx, el, existingLabel);
        const quoted = quoteValue(markerText);
        if (labelSpan !== null && quoted !== null) {
          edits.push({
            start: labelSpan.start,
            end: labelSpan.end,
            replacement: quoted,
            label: `fill the empty aria-label with ${TODO_MARKER}`,
          });
        }
      } else {
        const insertAt = attrInsertPoint(ctx, el);
        if (insertAt !== null) {
          edits.push({
            start: insertAt,
            end: insertAt,
            replacement: spacedAttr(ctx, insertAt, `aria-label="${markerText}"`),
            label: `add aria-label with ${TODO_MARKER}`,
          });
        }
      }
      out.push(
        ctx.report({
          ruleId: emptyLink.id,
          wcag: emptyLink.wcag,
          level: emptyLink.level,
          severity: emptyLink.severity,
          start: span.start,
          end: span.end,
          message:
            existingLabel === undefined
              ? 'Link is empty: it has no text, no aria-label and no labelled content.'
              : 'Link is empty: it has no text and its aria-label is an empty string.',
          impact:
            'A screen reader announces "link" with no destination, and in a list of the page\'s links it appears as a blank row a user can only explore by activating it.',
          fix: {
            // An advisory means "no patch offered", and this rule offers one: fixAllowed
            // refuses any fix carrying both, so the guidance goes in the description or
            // the edits are dead weight nothing can ever apply.
            safety: 'manual',
            edits,
            description:
              `Inserts aria-label="${TODO_MARKER} …" for a human to complete. The marker fails ` +
              'CI on purpose: replace it with text naming the destination, or delete the link ' +
              'if it is decorative. Written only under --mark-todos.',
          },
        }),
      );
    }
    return out;
  },
};

const genericLinkText: Rule = {
  id: 'A11Y-LINK-002',
  title: 'Generic link text',
  wcag: ['2.4.4', '2.4.9'],
  level: 'A',
  severity: 'warning',
  summary: '"Click here", "read more" and friends describe nothing when read out of context.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    const lang = documentLanguage(ctx);
    // English always applies: it is the default vocabulary of most codebases even when
    // the rendered page is not English.
    const phrases = new Set<string>(GENERIC_LINK_TEXT['en']);
    for (const phrase of GENERIC_LINK_TEXT[lang] ?? []) phrases.add(phrase);

    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (!isAnchor(el, jsx)) continue;
      if (!readBindable(el, 'href').present) continue;

      const name = nameOf(el);
      if (name.opaque) continue;
      const normalized = normalizeText(name.text);
      if (normalized === '' || !phrases.has(normalized)) continue;

      const span = elementSpan(el);
      out.push(
        ctx.report({
          ruleId: genericLinkText.id,
          wcag: genericLinkText.wcag,
          level: genericLinkText.level,
          severity: genericLinkText.severity,
          start: span.start,
          end: span.end,
          message: `Link text "${truncate(name.text, 40)}" does not describe where the link goes.`,
          impact:
            'Screen-reader users navigate by pulling up a list of every link on the page. Twelve entries all reading "read more" are indistinguishable there, so the list — the fastest way to move around a page — becomes useless.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Rewrite the link text to name its destination.',
            advisory:
              'Move the meaningful words into the link: "Read more about the 2024 results" rather than "read more". If the visible wording must stay, add an aria-label carrying the full phrase.',
          },
        }),
      );
    }
    return out;
  },
};

const rawUrlLinkText: Rule = {
  id: 'A11Y-LINK-003',
  title: 'Link text is a bare URL',
  wcag: ['2.4.4'],
  level: 'A',
  severity: 'warning',
  summary: 'A long URL used as link text is announced character by character.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isAnchor(el, jsx)) continue;
      if (!readBindable(el, 'href').present) continue;
      // An aria-label replaces the visible text as the announced name, so a URL shown on
      // screen next to a real label is not this problem.
      const label = readAttr(el, 'aria-label');
      if (label.present) continue;
      if (hasAttr(el, 'aria-labelledby')) continue;
      if (hasOpaqueContent(el)) continue;

      const text = textOf(el).trim();
      if (text.length <= 30 || !BARE_URL.test(text)) continue;

      const span = elementSpan(el);
      out.push(
        ctx.report({
          ruleId: rawUrlLinkText.id,
          wcag: rawUrlLinkText.wcag,
          level: rawUrlLinkText.level,
          severity: rawUrlLinkText.severity,
          start: span.start,
          end: span.end,
          message: `Link text is a bare URL ${text.length} characters long.`,
          impact:
            'Most screen readers spell a URL out — "h t t p s colon slash slash w w w dot" — so the user waits through a stream of punctuation to learn something a few words would have told them.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Replace the URL with the name of the page it points to.',
            advisory:
              'Use the destination\'s title as the link text and keep the URL in href. If the address itself must stay visible, add an aria-label with the human-readable name.',
          },
        }),
      );
    }
    return out;
  },
};

/**
 * Hardening, reported as information rather than as a fault.
 *
 * Every major browser has implied `noopener` for `target="_blank"` since early 2021
 * (Safari 12.1, Firefox 79, Chrome and Edge 88), so on anything current the handle this
 * rule is about is already severed. What is left is real but narrow: engines older than
 * that, and embedded webviews, where the opened page can still navigate this one.
 *
 * It was a warning, and on a museum's site that made it 1362 of 5774 findings — 24% of an
 * accessibility audit spent on a token with no WCAG criterion behind it, described with
 * an impact sentence that has been wrong on every current browser for five years. A
 * reader who knows that discounts the rest of the report, and should. Information is what
 * it is: worth writing, not worth counting as a barrier.
 */
const blankTargetRel: Rule = {
  id: 'A11Y-LINK-004',
  title: 'target="_blank" without rel="noopener"',
  wcag: [],
  level: 'A',
  severity: 'info',
  summary: 'A link opening a new tab leaves the handle back to this page to the browser default.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isLinkLike(el, jsx)) continue;
      const target = readBindable(el, 'target');
      if (!target.present || target.dynamic) continue;
      if (target.value.trim().toLowerCase() !== '_blank') continue;

      // A bound `:rel` overrides a static one at runtime in Vue, so inserting a literal
      // rel next to it would produce a fix that silently does nothing.
      const boundRel = el.attrs.find((a) => a.nameLower !== 'rel' && REL_ATTR_NAMES.includes(a.nameLower));
      const rel = boundRel ?? getAttr(el, 'rel');
      const relDynamic = rel !== undefined && (rel.dynamic || rel.quote === '{' || rel.nameLower !== 'rel');
      let explicitOpener = false;
      if (rel !== undefined && !relDynamic) {
        const tokens = (rel.value ?? '').split(/\s+/).filter((t) => t.length > 0).map((t) => t.toLowerCase());
        // noreferrer implies noopener in every browser that ships noreferrer, so either
        // token alone closes the hole.
        if (tokens.includes('noopener') || tokens.includes('noreferrer')) continue;
        // `rel="opener"` is an author asking for the handle on purpose — a popup that
        // posts back to its opener, most often. Merging noopener in would break that
        // silently, so this case is only ever described.
        explicitOpener = tokens.includes('opener');
      }

      const message =
        rel === undefined
          ? 'Link opens a new browsing context with target="_blank" and has no rel attribute.'
          : `Link opens a new browsing context with target="_blank" and rel="${truncate(rel.value ?? '', 40)}" does not include noopener.`;
      const impact =
        'Every major browser has implied noopener for target="_blank" since early 2021, so on a current one this is already closed. Older engines and embedded webviews do not: there the opened page keeps a live window.opener handle and can navigate this tab to a look-alike login page while the user reads the new one. Writing the token states the intent instead of relying on the user agent. This is hardening rather than a barrier for assistive technology, which is why it is reported as information.';

      const span = { start: el.openStart, end: el.openEnd };

      if (rel === undefined) {
        const insertAt = attrInsertPoint(ctx, el);
        // Only `noopener`. Adding `noreferrer` unasked also strips the Referer header,
        // which is a change to what the destination sees rather than an accessibility or
        // security fix, and it breaks analytics and referer-gated pages. It has no place
        // in the one edit this file writes without asking.
        const edits: readonly Edit[] =
          insertAt === null
            ? []
            : [
                {
                  start: insertAt,
                  end: insertAt,
                  replacement: spacedAttr(ctx, insertAt, 'rel="noopener"'),
                  label: 'add rel="noopener"',
                },
              ];
        out.push(
          ctx.report({
            ruleId: blankTargetRel.id,
            wcag: blankTargetRel.wcag,
            level: blankTargetRel.level,
            severity: blankTargetRel.severity,
            start: span.start,
            end: span.end,
            message,
            impact,
            fix: {
              safety: 'automatic',
              edits,
              description: 'Add rel="noopener" to the link.',
            },
          }),
        );
        continue;
      }

      if (relDynamic) {
        out.push(
          ctx.report({
            ruleId: blankTargetRel.id,
            wcag: blankTargetRel.wcag,
            level: blankTargetRel.level,
            severity: blankTargetRel.severity,
            start: rel.nameStart,
            end: rel.valueEnd,
            message: 'Link opens a new browsing context with target="_blank" and a computed rel value.',
            impact,
            fix: {
              safety: 'manual',
              edits: [],
              description: 'Ensure the computed rel value includes noopener.',
              advisory:
                'The rel value is an expression, so it cannot be rewritten safely from source. Make the expression always include "noopener".',
            },
          }),
        );
        continue;
      }

      if (explicitOpener) {
        out.push(
          ctx.report({
            ruleId: blankTargetRel.id,
            wcag: blankTargetRel.wcag,
            level: blankTargetRel.level,
            severity: blankTargetRel.severity,
            start: rel.nameStart,
            end: rel.valueEnd,
            message: 'Link opens a new browsing context and its rel asks for window.opener explicitly.',
            impact,
            fix: {
              safety: 'manual',
              edits: [],
              description: 'Confirm the opener handle is still wanted here.',
              advisory:
                'rel="opener" is a deliberate opt-in, so nothing is patched. If the destination no longer posts messages back to this page, replace the token with noopener.',
            },
          }),
        );
        continue;
      }

      // A rel already exists and must be merged rather than replaced: the existing tokens
      // may be load-bearing (rel="license", rel="nofollow"), so a human sees this one.
      const existing = (rel.value ?? '').trim();
      const merged = existing === '' ? 'noopener' : `${existing} noopener`;
      const edits: Edit[] = [];
      if (rel.value === null) {
        // Valueless `rel`: valueStart === valueEnd === nameEnd, so append `="…"`.
        if (rel.valueEnd <= el.openEnd) {
          edits.push({ start: rel.valueEnd, end: rel.valueEnd, replacement: '="noopener"', label: 'give rel a value' });
        }
      } else {
        const relValue = valueSpan(ctx, el, rel);
        if (relValue !== null && (rel.quote === '"' || rel.quote === "'")) {
          // Append inside the quotes the author already wrote. Replacing the whole span
          // means re-quoting the existing text, and a markup attribute value has no
          // escape syntax — JSON-style escaping here emits backslashes that a browser
          // reads literally and a quote that ends the attribute early.
          const at = relValue.end - 1;
          edits.push({
            start: at,
            end: at,
            replacement: existing === '' ? 'noopener' : ' noopener',
            label: 'merge noopener into rel',
          });
        } else if (relValue !== null && rel.quote === null) {
          // Unquoted: the value has to gain quotes before it can hold a second token.
          const quoted = quoteValue(merged);
          if (quoted !== null) {
            edits.push({ start: relValue.start, end: relValue.end, replacement: quoted, label: 'merge noopener into rel' });
          }
        }
      }

      out.push(
        ctx.report({
          ruleId: blankTargetRel.id,
          wcag: blankTargetRel.wcag,
          level: blankTargetRel.level,
          severity: blankTargetRel.severity,
          start: rel.nameStart,
          end: rel.valueEnd,
          message,
          impact,
          fix: {
            // Appending a token to a value someone else wrote deserves a human glance,
            // even though noopener cannot conflict with the tokens already there.
            safety: 'review',
            edits,
            description: `Merge noopener into the existing rel value ("${truncate(merged, 60)}").`,
          },
        }),
      );
    }
    return out;
  },
};

const unannouncedNewWindow: Rule = {
  id: 'A11Y-LINK-005',
  title: 'New window opened without warning',
  wcag: ['3.2.5'],
  level: 'AAA',
  severity: 'info',
  summary: 'target="_blank" with no hint in the link name that a new tab will open.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    const out: Violation[] = [];
    // Nothing can be said about a warning written in a language this rule cannot read.
    const hints = NEW_WINDOW_HINTS[documentLanguage(ctx)];
    if (hints === undefined) return out;

    for (const el of ctx.markup.elements) {
      if (!isLinkLike(el, jsx)) continue;
      const target = readBindable(el, 'target');
      if (!target.present || target.dynamic) continue;
      if (target.value.trim().toLowerCase() !== '_blank') continue;
      // A description may already carry the warning; assume the author meant it to.
      if (hasAttr(el, 'aria-describedby')) continue;

      const name = nameOf(el);
      if (name.opaque) continue;
      const title = readAttr(el, 'title');
      if (title.dynamic) continue;
      const haystack = normalizeText(`${name.text} ${title.value}`);
      if (haystack === '') continue; // unnamed link: A11Y-LINK-001 owns that
      if (hints.some((hint) => haystack.includes(hint))) continue;

      const span = elementSpan(el);
      out.push(
        ctx.report({
          ruleId: unannouncedNewWindow.id,
          wcag: unannouncedNewWindow.wcag,
          level: unannouncedNewWindow.level,
          severity: unannouncedNewWindow.severity,
          start: span.start,
          end: span.end,
          message: `Link "${truncate(name.text, 40)}" opens in a new tab but its name does not say so.`,
          impact:
            'A sighted user sees a second tab appear. Someone using a screen reader or a magnifier gets no signal at all, then finds the Back command dead because they are now in a window whose history is empty.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'State in the link that it opens a new window.',
            advisory:
              'Append visible or visually-hidden text such as "(opens in a new tab)", or extend the link name with the same words. Adding it automatically would rewrite text the tool did not author.',
          },
        }),
      );
    }
    return out;
  },
};

/**
 * Split an href into the part that identifies a page and the host it names, if any.
 *
 * `https://shm.ru/klub-druzey/` and `/klub-druzey/` are the same page written two ways,
 * and a CMS emits both from different templates on one page all day long. Comparing the
 * strings made four links to one destination look like four links to two, which is a
 * finding about ambiguity where there is none.
 *
 * Resolving properly needs the document's own URL, which a file in a repository does not
 * have. This does not need it: the rule only ever fires on *difference*, so where a
 * difference cannot be proved there must be none. A relative href is treated as agreeing
 * with any host — two links whose paths match are one destination unless both name a host
 * and the hosts differ.
 *
 * `mailto:`, `tel:` and `javascript:` have no authority, so they fall through as
 * themselves and compare exactly, which is what they should do.
 */
const AUTHORITY = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)(.*)$/i;

function destination(href: string): { readonly path: string; readonly host: string } {
  const m = AUTHORITY.exec(href.trim());
  if (m === null) return { path: href.trim(), host: '' };
  const rest = m[2] as string;
  return { path: rest === '' ? '/' : rest, host: (m[1] as string).toLowerCase() };
}

/**
 * How many destinations a set of hrefs really names, with one href to show for each.
 *
 * Paths agree or they do not. Where they agree, the links are one destination unless two
 * of them name different hosts.
 */
function distinctDestinations(hrefs: Iterable<string>): string[] {
  const byPath = new Map<string, Map<string, string>>();
  for (const href of hrefs) {
    const { path, host } = destination(href);
    let hosts = byPath.get(path);
    if (hosts === undefined) {
      hosts = new Map();
      byPath.set(path, hosts);
    }
    if (!hosts.has(host)) hosts.set(host, href);
  }
  const out: string[] = [];
  for (const hosts of byPath.values()) {
    const named = [...hosts].filter(([host]) => host !== '');
    // A relative href agrees with whatever host the page is served from, so it is only
    // its own destination when no absolute href shares its path.
    if (named.length === 0) out.push(hosts.get('') as string);
    else for (const [, href] of named) out.push(href);
  }
  return out;
}

const ambiguousLinkNames: Rule = {
  id: 'A11Y-LINK-006',
  title: 'Identical link text, different destinations',
  wcag: ['2.4.4', '2.4.9'],
  level: 'A',
  severity: 'info',
  summary: 'Two links in one file share a name but point somewhere different.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    interface Group {
      readonly els: Element[];
      readonly hrefs: Set<string>;
      readonly display: string;
    }
    const groups = new Map<string, Group>();

    for (const el of ctx.markup.elements) {
      if (!isAnchor(el, jsx)) continue;
      const href = readBindable(el, 'href');
      if (!href.present || href.dynamic) continue;
      const target = href.value.trim();
      if (target === '') continue;

      const name = nameOf(el);
      if (name.opaque) continue;
      const key = normalizeText(name.text);
      if (key === '') continue;

      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { els: [el], hrefs: new Set([target]), display: name.text.trim() });
      } else {
        existing.els.push(el);
        existing.hrefs.add(target);
      }
    }

    const out: Violation[] = [];
    for (const group of groups.values()) {
      const destinations = distinctDestinations(group.hrefs);
      if (destinations.length < 2) continue;
      const shown = destinations.slice(0, 3).map((h) => truncate(h, 32)).join(', ');
      const extra = destinations.length > 3 ? ', …' : '';
      for (const el of group.els) {
        const span = elementSpan(el);
        out.push(
          ctx.report({
            ruleId: ambiguousLinkNames.id,
            wcag: ambiguousLinkNames.wcag,
            level: ambiguousLinkNames.level,
            severity: ambiguousLinkNames.severity,
            start: span.start,
            end: span.end,
            message: `${group.els.length} links in this file are named "${truncate(group.display, 40)}" but point to ${destinations.length} different destinations (${shown}${extra}).`,
            impact:
              'The screen reader\'s list of links shows these as the same entry repeated. A user who picks one has no way to tell which destination they chose, and no way to return to the other.',
            fix: {
              safety: 'manual',
              edits: [],
              description: 'Make each link name identify its own destination.',
              advisory:
                'Extend each name with what distinguishes it — "Edit profile" and "Edit billing" rather than two links called "Edit" — in the visible text or in aria-label.',
            },
          }),
        );
      }
    }
    return out;
  },
};

const anchorAsButton: Rule = {
  id: 'A11Y-LINK-007',
  title: 'Anchor used as a button',
  wcag: ['4.1.2'],
  level: 'A',
  severity: 'warning',
  summary: 'href="#" or javascript:void(0) makes a button that announces itself as a link.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isAnchor(el, jsx)) continue;
      const href = getAttr(el, 'href');
      if (href === undefined || href.dynamic || href.quote === '{') continue;
      const value = href.value ?? '';
      if (!isPlaceholderHref(value)) continue;

      // role="button" fixes the announcement but not the Space key; still worth saying,
      // so only the message softens.
      const role = readAttr(el, 'role');
      const rolePatched = !role.dynamic && role.value.trim().toLowerCase() === 'button';
      const handler = hasClickHandler(el);

      // Two different problems share this shape, and reporting them at the same weight
      // was drowning the report: 317 findings on one component library, all of them
      // placeholders in example files, filling the space where real defects should be.
      //
      // An anchor with a click handler genuinely is a button written as a link: it is
      // announced wrong, it is in the link list, and Space scrolls the page instead of
      // activating it. Those are real defects and stay warnings.
      //
      // An anchor with no handler at all is an unfinished link. It navigates to the top
      // of the page, which is useless but is not a mislabelled control, and calling it
      // the same thing overstates it.
      const actsAsButton = handler || rolePatched;

      out.push(
        ctx.report({
          ruleId: anchorAsButton.id,
          wcag: anchorAsButton.wcag,
          level: anchorAsButton.level,
          severity: actsAsButton ? 'warning' : 'info',
          start: href.nameStart,
          end: href.valueEnd,
          message: actsAsButton
            ? `Anchor with href="${truncate(value.trim(), 30)}"${handler ? ' and a click handler' : ''} is a button written as a link${rolePatched ? ' with role="button" bolted on' : ''}.`
            : `Anchor with href="${truncate(value.trim(), 30)}" and no handler goes nowhere.`,
          // Two hrefs reach this branch and they do different things. `#` scrolls to the
          // top of the document; a `javascript:` URL whose script result is not a string
          // navigates nowhere at all. Saying "leads back to the top" about both also
          // contradicted the message directly above it, which says "goes nowhere" — and
          // the live instance was an nlr.ru link titled «наверх», where a reader checking
          // one sentence against the other finds the report arguing with itself.
          impact: actsAsButton
            ? 'A screen reader announces "link" and promises navigation that never happens; the link also appears in the page\'s link list, where it leads nowhere. Unlike a button it ignores the Space key, so a keyboard user who presses Space scrolls the page instead of activating the control.'
            : value.trim() === '#'
              ? 'The link appears in a screen reader\'s list of links on the page and leads back to the top of it. A user navigating by link list has to try it to find that out.'
              : 'The link appears in a screen reader\'s list of links on the page and does not navigate at all. A user navigating by link list has to try it to find that out.',
          fix: {
            // No edits and an advisory: this is a human's job, and calling it 'review'
            // would count it among the fixes `--fix --include-review` promises to write.
            safety: 'manual',
            edits: [],
            description: actsAsButton
              ? 'Replace the anchor with a <button type="button">.'
              : 'Give the link a real destination, or make it a <button>.',
            advisory: actsAsButton
              ? 'Change <a href="#"> to <button type="button"> and move the click handler across, then restore the link appearance in CSS (background: none; border: 0; padding: 0). The tool declines to patch this because moving an element changes styling and event wiring it cannot see.'
              : 'Point href at where this is meant to go. If it is a placeholder in an example, that is fine — but it will be copied into someone\'s application exactly as written.',
          },
        }),
      );
    }
    return out;
  },
};

const brokenFragment: Rule = {
  id: 'A11Y-LINK-008',
  title: 'Fragment link with no target',
  wcag: ['2.4.4'],
  level: 'A',
  severity: 'warning',
  summary: 'An in-page link points at an id that this document never defines.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    // Only a whole document can be checked. A component file may legitimately link into a
    // page assembled elsewhere, and flagging that would be wrong every time.
    const isDocument = ctx.markup.elements.some((e) => e.tagLower === 'html' || e.tagLower === 'body');
    if (!isDocument) return [];

    const ids = new Set<string>();
    for (const el of ctx.markup.elements) {
      for (const a of el.attrs) {
        const isIdAttr =
          a.nameLower === 'id' ||
          a.nameLower === ':id' ||
          a.nameLower === 'v-bind:id' ||
          a.nameLower === 'x-bind:id';
        if (!isIdAttr) continue;
        // A computed id could be anything, so no absence can be proven in this file.
        if (a.dynamic || a.quote === '{' || a.value === null) return [];
        ids.add(a.value.trim());
      }
      if (el.tagLower === 'a') {
        const legacy = getAttr(el, 'name');
        if (legacy !== undefined && !legacy.dynamic && legacy.quote !== '{' && legacy.value !== null) {
          ids.add(legacy.value.trim());
        }
      }
    }

    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (!isAnchor(el, jsx)) continue;
      const href = getAttr(el, 'href');
      if (href === undefined || href.dynamic || href.quote === '{' || href.value === null) continue;
      const raw = href.value.trim();
      if (!raw.startsWith('#')) continue;

      const fragment = raw.slice(1);
      if (fragment === '') continue; // href="#" belongs to A11Y-LINK-007
      if (fragment.startsWith('/') || fragment.startsWith('!')) continue; // hash-router path
      if (fragment.toLowerCase() === 'top') continue; // defined by the browser itself

      let decoded = fragment;
      try {
        decoded = decodeURIComponent(fragment);
      } catch {
        // Malformed escape: compare the raw form only.
      }
      if (ids.has(fragment) || ids.has(decoded)) continue;

      out.push(
        ctx.report({
          ruleId: brokenFragment.id,
          wcag: brokenFragment.wcag,
          level: brokenFragment.level,
          severity: brokenFragment.severity,
          start: href.nameStart,
          end: href.valueEnd,
          message: `Fragment link points at "#${truncate(fragment, 40)}", and no element in this document has that id.`,
          impact:
            'Activating the link moves neither the viewport nor the focus, so a keyboard or screen-reader user gets no feedback that anything happened and cannot tell the link from a broken control. A "skip to content" link that misses its target strands them at the top of the page.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Point the link at an element that exists.',
            advisory:
              `Add id="${truncate(fragment, 40)}" to the intended target, or correct the href. Choosing which of the two is right needs knowledge of the page's structure.`,
          },
        }),
      );
    }
    return out;
  },
};

const adjacentDuplicateLinks: Rule = {
  id: 'A11Y-LINK-009',
  title: 'Adjacent duplicate links',
  wcag: [],
  level: 'A',
  severity: 'info',
  summary: 'Two neighbouring links to the same destination produce two identical tab stops.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const jsx = isJsxFile(ctx);
    const out: Violation[] = [];
    const seen = new Set<number>();

    for (const siblings of siblingGroups(ctx)) {
      for (let i = 1; i < siblings.length; i++) {
        const prev = siblings[i - 1];
        const next = siblings[i];
        if (prev === undefined || next === undefined) continue;
        if (!isAnchor(prev, jsx) || !isAnchor(next, jsx)) continue;

        const a = readBindable(prev, 'href');
        const b = readBindable(next, 'href');
        if (!a.present || !b.present || a.dynamic || b.dynamic) continue;
        const dest = a.value.trim();
        if (dest === '' || dest !== b.value.trim()) continue;

        // "Adjacent" must mean nothing readable sits between them; text in between makes
        // the second link a separate, legitimate mention.
        if (next.openStart < prev.end) continue;
        if (ctx.source.slice(prev.end, next.openStart).trim() !== '') continue;
        if (seen.has(next.openStart)) continue;
        seen.add(next.openStart);

        const span = elementSpan(next);
        out.push(
          ctx.report({
            ruleId: adjacentDuplicateLinks.id,
            wcag: adjacentDuplicateLinks.wcag,
            level: adjacentDuplicateLinks.level,
            severity: adjacentDuplicateLinks.severity,
            start: span.start,
            end: span.end,
            message: `Link repeats the destination "${truncate(dest, 40)}" of the link immediately before it.`,
            impact:
              'The pattern costs a keyboard user an extra Tab press per item — noticeable across a list of thirty — and a screen reader reads the same destination twice in a row, which sounds like a duplicated entry rather than one thing.',
            fix: {
              safety: 'manual',
              edits: [],
              description: 'Merge the two links into one.',
              advisory:
                'Wrap the icon and the text in a single <a> and mark the icon decorative (alt="" or aria-hidden="true"). Merging spans across two elements is a structural edit, so it is left to a human.',
            },
          }),
        );
      }
    }
    return out;
  },
};

export const RULES: readonly Rule[] = [
  emptyLink,
  genericLinkText,
  rawUrlLinkText,
  blankTargetRel,
  unannouncedNewWindow,
  ambiguousLinkNames,
  anchorAsButton,
  brokenFragment,
  adjacentDuplicateLinks,
];
