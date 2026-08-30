/**
 * ARIA correctness — ARIA that is *wrong* rather than missing.
 *
 * A missing ARIA attribute usually degrades to the native semantics of the element.
 * A wrong one does not: `role="buton"` is dropped on the floor, `aria-labeledby`
 * silently names nothing, `aria-hidden="1"` is not a boolean so the element stays
 * exposed, and `aria-labelledby="missing-id"` produces an accessible name of the empty
 * string while every automated checker downstream reports the element as labelled.
 * That is why this family exists: these defects are rarer than missing alt text but
 * they actively misinform assistive technology, and they are invisible in the rendered
 * page unless you go looking with a screen reader.
 *
 * Two constraints shape every rule below.
 *
 * 1. A dynamic value (`aria-hidden={x}`, `:aria-label="t"`) can be anything at runtime.
 *    We report structural problems that hold regardless of the value, and we never
 *    rewrite the expression. Renaming a misspelled *attribute name* is still allowed —
 *    that touches no expression.
 * 2. A file is a fragment more often than it is a document. Anything that depends on
 *    what surrounds an element (required parent roles, id references) is checked
 *    leniently: we fire only when the file itself contains enough context to be sure.
 */

import type { Edit, Fix, FixSafety, Rule, RuleContext, Violation } from '../types.js';
import { TODO_MARKER } from '../types.js';
import type { Attr, Element } from '../parse/markup.js';
import { getAttr, hasAttr, textOf } from '../parse/markup.js';

// ---------------------------------------------------------------------------
// The ARIA tables
//
// Deliberately not the whole specification. The bias throughout is towards *not*
// reporting: an unknown-but-real role that we fail to list would produce a false
// "invalid role" on working code, which is far more expensive than a missed typo.
// ---------------------------------------------------------------------------

/** Concrete roles an author may put in markup (WAI-ARIA 1.2, plus stable 1.3 additions). */
const VALID_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button',
  'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'comment',
  'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log',
  'main', 'mark', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton',
  'status', 'strong', 'subscript', 'suggestion', 'superscript', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar',
  'tooltip', 'tree', 'treegrid', 'treeitem',
]);

/**
 * Abstract roles exist only to organise the taxonomy. They are never valid in markup,
 * and they are worth naming separately because the author clearly meant a real role —
 * `role="section"` and `role="input"` read like they should work.
 */
const ABSTRACT_ROLES: ReadonlySet<string> = new Set([
  'command', 'composite', 'input', 'landmark', 'range', 'roletype', 'section',
  'sectionhead', 'select', 'structure', 'widget', 'window',
]);

/** Every `aria-*` attribute defined by ARIA 1.2 (with the 1.3 braille pair). */
const VALID_ARIA: ReadonlySet<string> = new Set([
  'aria-activedescendant', 'aria-atomic', 'aria-autocomplete', 'aria-braillelabel',
  'aria-brailleroledescription', 'aria-busy', 'aria-checked', 'aria-colcount',
  'aria-colindex', 'aria-colindextext', 'aria-colspan', 'aria-controls', 'aria-current',
  'aria-describedby', 'aria-description', 'aria-details', 'aria-disabled',
  'aria-dropeffect', 'aria-errormessage', 'aria-expanded', 'aria-flowto', 'aria-grabbed',
  'aria-haspopup', 'aria-hidden', 'aria-invalid', 'aria-keyshortcuts', 'aria-label',
  'aria-labelledby', 'aria-level', 'aria-live', 'aria-modal', 'aria-multiline',
  'aria-multiselectable', 'aria-orientation', 'aria-owns', 'aria-placeholder',
  'aria-posinset', 'aria-pressed', 'aria-readonly', 'aria-relevant', 'aria-required',
  'aria-roledescription', 'aria-rowcount', 'aria-rowindex', 'aria-rowindextext',
  'aria-rowspan', 'aria-selected', 'aria-setsize', 'aria-sort', 'aria-valuemax',
  'aria-valuemin', 'aria-valuenow', 'aria-valuetext',
]);

/**
 * Attributes allowed on any role. `aria-disabled` and `aria-errormessage` are global
 * only from ARIA 1.3; they are listed here anyway so that a page written against the
 * newer spec is not reported as broken.
 */
const GLOBAL_ARIA: ReadonlySet<string> = new Set([
  'aria-atomic', 'aria-braillelabel', 'aria-brailleroledescription', 'aria-busy',
  'aria-controls', 'aria-current', 'aria-describedby', 'aria-description', 'aria-details',
  'aria-disabled', 'aria-dropeffect', 'aria-errormessage', 'aria-flowto', 'aria-grabbed',
  'aria-haspopup', 'aria-hidden', 'aria-invalid', 'aria-keyshortcuts', 'aria-label',
  'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant', 'aria-roledescription',
]);

/** Allowed literal values, for the attributes whose value is a fixed token set. */
const ARIA_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // Boolean and tristate.
  'aria-atomic': ['true', 'false'],
  'aria-busy': ['true', 'false'],
  'aria-disabled': ['true', 'false'],
  'aria-hidden': ['true', 'false'],
  'aria-modal': ['true', 'false'],
  'aria-multiline': ['true', 'false'],
  'aria-multiselectable': ['true', 'false'],
  'aria-readonly': ['true', 'false'],
  'aria-required': ['true', 'false'],
  'aria-expanded': ['true', 'false', 'undefined'],
  'aria-grabbed': ['true', 'false', 'undefined'],
  'aria-selected': ['true', 'false', 'undefined'],
  'aria-checked': ['true', 'false', 'mixed', 'undefined'],
  'aria-pressed': ['true', 'false', 'mixed', 'undefined'],
  // Enumerated.
  'aria-autocomplete': ['inline', 'list', 'both', 'none'],
  'aria-current': ['false', 'true', 'page', 'step', 'location', 'date', 'time'],
  'aria-haspopup': ['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog'],
  'aria-invalid': ['false', 'true', 'grammar', 'spelling'],
  'aria-live': ['off', 'polite', 'assertive'],
  'aria-orientation': ['horizontal', 'vertical', 'undefined'],
  'aria-sort': ['ascending', 'descending', 'none', 'other'],
};

/** The subset of the above whose value is conceptually a boolean. */
const BOOLEAN_ARIA: ReadonlySet<string> = new Set([
  'aria-atomic', 'aria-busy', 'aria-checked', 'aria-disabled', 'aria-expanded',
  'aria-grabbed', 'aria-hidden', 'aria-modal', 'aria-multiline', 'aria-multiselectable',
  'aria-pressed', 'aria-readonly', 'aria-required', 'aria-selected',
]);

/** Space-separated token lists rather than a single token. */
const ARIA_TOKEN_LISTS: Readonly<Record<string, readonly string[]>> = {
  'aria-relevant': ['additions', 'removals', 'text', 'all'],
  'aria-dropeffect': ['copy', 'move', 'link', 'execute', 'popup', 'none'],
};

const ARIA_INTEGER: ReadonlySet<string> = new Set([
  'aria-colcount', 'aria-colindex', 'aria-colspan', 'aria-level', 'aria-posinset',
  'aria-rowcount', 'aria-rowindex', 'aria-rowspan', 'aria-setsize',
]);

const ARIA_NUMBER: ReadonlySet<string> = new Set([
  'aria-valuemax', 'aria-valuemin', 'aria-valuenow',
]);

/** What a human plausibly meant by a non-boolean boolean. */
const TRUTHY: ReadonlySet<string> = new Set(['yes', 'y', 'on', '1', 't', 'enabled']);
const FALSY: ReadonlySet<string> = new Set(['no', 'n', 'off', '0', 'f', 'disabled']);

/**
 * Non-global `aria-*` attributes each role supports. Roles absent from this table are
 * simply not checked by A11Y-ARIA-011 — an incomplete row would invent violations,
 * so partial data is expressed as *no* data rather than as an empty row.
 */
const ROLE_SUPPORTED: Readonly<Record<string, readonly string[]>> = {
  alert: [],
  alertdialog: ['aria-modal'],
  article: ['aria-posinset', 'aria-setsize'],
  banner: [],
  button: ['aria-expanded', 'aria-pressed'],
  cell: ['aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan'],
  checkbox: ['aria-checked', 'aria-readonly', 'aria-required'],
  columnheader: ['aria-colindex', 'aria-colspan', 'aria-expanded', 'aria-readonly',
    'aria-required', 'aria-rowindex', 'aria-rowspan', 'aria-selected', 'aria-sort'],
  combobox: ['aria-activedescendant', 'aria-autocomplete', 'aria-expanded',
    'aria-readonly', 'aria-required'],
  complementary: [],
  contentinfo: [],
  dialog: ['aria-modal'],
  form: [],
  grid: ['aria-activedescendant', 'aria-colcount', 'aria-level', 'aria-multiselectable',
    'aria-readonly', 'aria-rowcount'],
  gridcell: ['aria-colindex', 'aria-colspan', 'aria-expanded', 'aria-readonly',
    'aria-required', 'aria-rowindex', 'aria-rowspan', 'aria-selected'],
  group: ['aria-activedescendant'],
  heading: ['aria-level'],
  img: [],
  link: ['aria-expanded'],
  list: [],
  listbox: ['aria-activedescendant', 'aria-expanded', 'aria-multiselectable',
    'aria-orientation', 'aria-readonly', 'aria-required'],
  listitem: ['aria-level', 'aria-posinset', 'aria-setsize'],
  main: [],
  menu: ['aria-activedescendant', 'aria-orientation'],
  menubar: ['aria-activedescendant', 'aria-orientation'],
  menuitem: ['aria-expanded', 'aria-posinset', 'aria-setsize'],
  menuitemcheckbox: ['aria-checked', 'aria-expanded', 'aria-posinset', 'aria-setsize'],
  menuitemradio: ['aria-checked', 'aria-expanded', 'aria-posinset', 'aria-setsize'],
  navigation: [],
  none: [],
  option: ['aria-checked', 'aria-posinset', 'aria-selected', 'aria-setsize'],
  presentation: [],
  progressbar: ['aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'],
  radio: ['aria-checked', 'aria-posinset', 'aria-setsize'],
  radiogroup: ['aria-activedescendant', 'aria-orientation', 'aria-readonly',
    'aria-required'],
  region: [],
  row: ['aria-colindex', 'aria-expanded', 'aria-level', 'aria-posinset', 'aria-rowindex',
    'aria-selected', 'aria-setsize'],
  rowheader: ['aria-colindex', 'aria-colspan', 'aria-expanded', 'aria-readonly',
    'aria-required', 'aria-rowindex', 'aria-rowspan', 'aria-selected', 'aria-sort'],
  search: [],
  separator: ['aria-orientation', 'aria-valuemax', 'aria-valuemin', 'aria-valuenow',
    'aria-valuetext'],
  slider: ['aria-orientation', 'aria-readonly', 'aria-required', 'aria-valuemax',
    'aria-valuemin', 'aria-valuenow', 'aria-valuetext'],
  spinbutton: ['aria-readonly', 'aria-required', 'aria-valuemax', 'aria-valuemin',
    'aria-valuenow', 'aria-valuetext'],
  status: [],
  switch: ['aria-checked', 'aria-readonly', 'aria-required'],
  tab: ['aria-expanded', 'aria-posinset', 'aria-selected', 'aria-setsize'],
  table: ['aria-colcount', 'aria-rowcount'],
  tablist: ['aria-activedescendant', 'aria-level', 'aria-multiselectable',
    'aria-orientation'],
  tabpanel: [],
  textbox: ['aria-activedescendant', 'aria-autocomplete', 'aria-multiline',
    'aria-placeholder', 'aria-readonly', 'aria-required'],
  toolbar: ['aria-activedescendant', 'aria-orientation'],
  tooltip: [],
  tree: ['aria-activedescendant', 'aria-multiselectable', 'aria-orientation',
    'aria-required'],
  treeitem: ['aria-checked', 'aria-expanded', 'aria-level', 'aria-posinset',
    'aria-selected', 'aria-setsize'],
};

/**
 * Roles for which naming by the author is *prohibited* — the name is discarded, so an
 * `aria-label` on one of these is dead code that reads as if the job were done.
 */
const NAME_PROHIBITED_ROLES: ReadonlySet<string> = new Set([
  'caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'mark', 'none',
  'paragraph', 'presentation', 'strong', 'subscript', 'superscript', 'term', 'time',
]);

/**
 * Roles whose required parent must be somewhere up the ancestor chain. Checked
 * leniently (any ancestor, not just the immediate one) because wrapper elements
 * between a `tablist` and its `tab`s are common and legal.
 */
const REQUIRED_CONTEXT: Readonly<Record<string, readonly string[]>> = {
  option: ['listbox'],
  tab: ['tablist'],
  menuitem: ['menu', 'menubar'],
  menuitemcheckbox: ['menu', 'menubar'],
  menuitemradio: ['menu', 'menubar'],
  treeitem: ['tree', 'group'],
  listitem: ['list', 'directory'],
  row: ['table', 'grid', 'treegrid', 'rowgroup'],
  rowgroup: ['table', 'grid', 'treegrid'],
  gridcell: ['row'],
  cell: ['row'],
  columnheader: ['row'],
  rowheader: ['row'],
};

/** Elements with no semantics of their own, where an accessible name has nothing to attach to. */
const GENERIC_TAGS: ReadonlySet<string> = new Set([
  'div', 'span', 'p', 'i', 'b', 'em', 'strong', 'small', 'u', 's', 'font', 'center',
]);

/** Sectioning content: `<header>`/`<footer>` inside one of these is not a landmark. */
const SECTIONING_TAGS: ReadonlySet<string> = new Set([
  'article', 'aside', 'main', 'nav', 'section',
]);

const WCAG_412 = ['4.1.2'] as const;
const WCAG_131 = ['1.3.1'] as const;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type ReportInput = Omit<Violation, 'line' | 'column' | 'file' | 'excerpt'>;

/**
 * `exactOptionalPropertyTypes` forbids passing `fix: undefined`, and every rule here
 * has both a patchable and an advice-only branch, so the optional property is attached
 * rather than spread with a possibly-undefined value.
 */
function report(ctx: RuleContext, base: Omit<ReportInput, 'fix'>, fix?: Fix): Violation {
  return fix === undefined ? ctx.report(base) : ctx.report({ ...base, fix });
}

function makeFix(
  safety: FixSafety,
  description: string,
  edits: readonly Edit[],
  advisory?: string,
): Fix {
  return advisory === undefined
    ? { safety, edits, description }
    : { safety, edits, description, advisory };
}

/** Advice with no patch: the tool knows what is wrong but not what the author meant. */
function advice(description: string, advisory: string): Fix {
  return makeFix('manual', description, [], advisory);
}

/** JSX component. Its props are not HTML attributes and its rendered tag is unknown. */
function isComponent(el: Element): boolean {
  const first = el.tag[0];
  return first !== undefined && first >= 'A' && first <= 'Z';
}

/** True when the value is an expression we must not read as text or rewrite. */
function isDynamic(attr: Attr): boolean {
  return attr.dynamic || attr.quote === '{';
}

/**
 * A literal value we may reason about. `null` covers both expressions and the
 * valueless form: in JSX `<div aria-hidden />` means `aria-hidden={true}`, so treating
 * a missing value as an error would fire on correct code in every React codebase.
 */
function literalValue(attr: Attr | undefined): string | null {
  if (attr === undefined || isDynamic(attr) || attr.value === null) return null;
  return attr.value;
}

function tokensOf(value: string): string[] {
  return value.trim().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * The role tokens written on an element, or `null` when there is no static role.
 * DPUB and SVG-graphics roles are namespaced and always accepted.
 */
function roleTokens(el: Element): string[] | null {
  const value = literalValue(getAttr(el, 'role'));
  if (value === null) return null;
  const tokens = tokensOf(value);
  return tokens.length === 0 ? null : tokens;
}

function isKnownRole(token: string): boolean {
  return VALID_ROLES.has(token) || token.startsWith('doc-') || token.startsWith('graphics-');
}

/** ARIA uses the first token it recognises; the rest are fallbacks. */
function effectiveRole(el: Element): string | undefined {
  const tokens = roleTokens(el);
  if (tokens === null) return undefined;
  return tokens.find((t) => VALID_ROLES.has(t));
}

/**
 * Levenshtein distance, capped. The cap keeps the work bounded and means a long
 * attribute name cannot be "corrected" into something unrelated.
 */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      curr.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = curr;
  }
  return prev[b.length] as number;
}

/** Two adjacent characters swapped — `aria-lable`, `tablsit`. Levenshtein scores this 2. */
function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diff.push(i);
      if (diff.length > 2) return false;
    }
  }
  if (diff.length !== 2) return false;
  const [i, j] = diff as [number, number];
  return j === i + 1 && a[i] === b[j] && a[j] === b[i];
}

/**
 * Candidates that are one keystroke away. Anything further is a guess, and a guess
 * that rewrites source is exactly what this tool refuses to do.
 */
function nearMatches(token: string, candidates: Iterable<string>): string[] {
  const near: string[] = [];
  for (const candidate of candidates) {
    if (candidate === token) continue;
    if (distance(token, candidate, 1) <= 1 || isTransposition(token, candidate)) {
      near.push(candidate);
    }
  }
  return near.sort();
}

/**
 * Insert a whole attribute just before the `>` that closes the opening tag. `text` is
 * the attribute alone; the surrounding whitespace is worked out from the source so the
 * result does not gain a double space or lose the one before `/>`.
 */
function insertAttrEdit(ctx: RuleContext, el: Element, text: string, label: string): Edit | null {
  if (ctx.source[el.openEnd - 1] !== '>') return null; // unterminated tag: do not touch
  // A void element (`<img src=x>`) is flagged self-closing but has no slash to skip,
  // so the character itself decides, not the flag.
  const slash = ctx.source[el.openEnd - 2] === '/';
  const insertAt = el.openEnd - (el.selfClosing && slash ? 2 : 1);
  const prev = ctx.source[insertAt - 1];
  const spaced = prev === undefined || prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r';
  const replacement = spaced ? `${text}${slash ? ' ' : ''}` : ` ${text}`;
  return { start: insertAt, end: insertAt, replacement, label };
}

/** Delete an attribute and the single space that separated it from its neighbour. */
function removeAttrEdit(ctx: RuleContext, attr: Attr, label: string): Edit {
  const prev = ctx.source[attr.nameStart - 1];
  const start = prev === ' ' || prev === '\t' ? attr.nameStart - 1 : attr.nameStart;
  return { start, end: attr.valueEnd, replacement: '', label };
}

/** Replace an attribute value, quotes included. Never call this on a dynamic value. */
function replaceValueEdit(attr: Attr, value: string, label: string): Edit {
  return { start: attr.valueStart, end: attr.valueEnd, replacement: JSON.stringify(value), label };
}

// ---------------------------------------------------------------------------
// A11Y-ARIA-001 — role that is not a role
// ---------------------------------------------------------------------------

const invalidRole: Rule = {
  id: 'A11Y-ARIA-001',
  title: 'role must be a defined ARIA role',
  wcag: WCAG_412,
  level: 'A',
  severity: 'error',
  summary: 'Flags role values that are misspelled, abstract, or not ARIA roles at all.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const attr = getAttr(el, 'role');
      if (attr === undefined || isDynamic(attr)) continue;

      const raw = attr.value;
      if (raw === null || raw.trim() === '') {
        out.push(
          report(ctx, {
            ruleId: invalidRole.id,
            wcag: WCAG_412,
            level: 'A',
            severity: 'error',
            start: attr.nameStart,
            end: attr.valueEnd,
            message: `<${el.tag}> has an empty role attribute.`,
            impact:
              'An empty role is ignored, so the element keeps whatever semantics it had — ' +
              'usually none. A screen reader user hears no indication of what the element is.',
          }, advice(
            'Remove the empty role, or give it the role you intended.',
            'Either delete role or set it to the intended ARIA role.',
          )),
        );
        continue;
      }

      const tokens = tokensOf(raw);
      const bad = tokens.filter((t) => !isKnownRole(t));
      if (bad.length === 0) continue;

      // One violation per element: the first bad token is the one to fix.
      const token = bad[0] as string;
      const lower = token.toLowerCase();
      const single = tokens.length === 1;
      const abstract = ABSTRACT_ROLES.has(lower);

      const message = abstract
        ? `<${el.tag}> uses role="${token}", which is an abstract ARIA role and is never valid in markup.`
        : `<${el.tag}> uses role="${token}", which is not a defined ARIA role.`;
      const impact =
        'The role is discarded, so assistive technology falls back to the element’s native ' +
        `semantics${el.tagLower === 'div' || el.tagLower === 'span' ? ' — for a generic element, none at all' : ''}. ` +
        'The widget is announced as plain content and its state is never spoken.';

      const base = {
        ruleId: invalidRole.id,
        wcag: WCAG_412,
        level: 'A' as const,
        severity: 'error' as const,
        start: attr.nameStart,
        end: attr.valueEnd,
        message,
        impact,
      };

      // A value that is only miscased is unambiguous: ARIA roles are lowercase.
      if (!abstract && isKnownRole(lower) && single) {
        out.push(
          report(ctx, base, makeFix(
            'review',
            `Lowercase the role to role="${lower}".`,
            [replaceValueEdit(attr, lower, `role="${token}" → role="${lower}"`)],
          )),
        );
        continue;
      }

      const near = abstract ? [] : nearMatches(lower, VALID_ROLES);
      if (near.length === 1 && single) {
        const suggestion = near[0] as string;
        out.push(
          report(ctx, base, makeFix(
            'review',
            `Correct the misspelled role to role="${suggestion}".`,
            [replaceValueEdit(attr, suggestion, `role="${token}" → role="${suggestion}"`)],
            // No advisory: a single-keystroke match is confident enough to patch.
          )),
        );
        continue;
      }

      const suggestionText = near.length > 0
        ? `Did you mean ${near.map((r) => `role="${r}"`).join(' or ')}?`
        : abstract
          ? 'Abstract roles cannot be used directly; pick the concrete role you meant.'
          : 'Choose a role from the ARIA specification, or remove the attribute and use a native element.';
      out.push(
        report(ctx, base,
          advice(`role="${token}" needs a human decision.`, suggestionText)),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-002 — aria-* attribute that does not exist
// ---------------------------------------------------------------------------

const unknownAriaAttribute: Rule = {
  id: 'A11Y-ARIA-002',
  title: 'aria-* attribute must be a defined ARIA attribute',
  wcag: WCAG_412,
  level: 'A',
  severity: 'error',
  summary: 'Flags misspelled or invented aria-* attributes, which browsers silently ignore.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      for (const attr of el.attrs) {
        const name = attr.nameLower;
        if (!name.startsWith('aria-') || VALID_ARIA.has(name)) continue;

        const near = nearMatches(name, VALID_ARIA);
        const base = {
          ruleId: unknownAriaAttribute.id,
          wcag: WCAG_412,
          level: 'A' as const,
          severity: 'error' as const,
          start: attr.nameStart,
          end: attr.valueEnd,
          message: `<${el.tag}> has "${attr.name}", which is not a defined ARIA attribute.`,
          impact:
            'Browsers expose no accessibility information for unknown attributes, so this line ' +
            'has no effect at all. The element behaves exactly as if the attribute were absent, ' +
            'while the source reads as though the problem were handled.',
        };

        // Only the attribute *name* is rewritten, so this is safe even when the value
        // is an expression: `aria-labeledby={id}` becomes `aria-labelledby={id}`.
        if (near.length === 1) {
          const suggestion = near[0] as string;
          out.push(
            report(ctx, base, makeFix(
              'review',
              `Rename ${attr.name} to ${suggestion}.`,
              [{
                start: attr.nameStart,
                end: attr.nameEnd,
                replacement: suggestion,
                label: `${attr.name} → ${suggestion}`,
              }],
            )),
          );
          continue;
        }

        out.push(
          report(ctx, base, advice(
            `${attr.name} needs a human decision.`,
            near.length > 0
              ? `Did you mean ${near.join(' or ')}?`
              : 'Remove the attribute or replace it with the ARIA attribute you intended.',
          )),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-003 — role that repeats the element's native semantics
// ---------------------------------------------------------------------------

/**
 * The role a browser already gives this element. Returns `undefined` whenever the
 * mapping depends on something we cannot see statically (`<select>` is a listbox or a
 * combobox depending on `size`/`multiple`), because a wrong "redundant" verdict would
 * delete a role that was doing real work.
 */
function implicitRole(el: Element): string | undefined {
  const tag = el.tagLower;
  if (/^h[1-6]$/.test(tag)) return 'heading';
  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
    case 'area':
      return hasAttr(el, 'href') ? 'link' : undefined;
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'aside':
      return 'complementary';
    case 'article':
      return 'article';
    case 'form':
      return 'form';
    case 'ul':
    case 'ol':
    case 'menu':
      return 'list';
    case 'li': {
      const p = el.parent;
      if (p === null) return undefined;
      return p.tagLower === 'ul' || p.tagLower === 'ol' || p.tagLower === 'menu'
        ? 'listitem'
        : undefined;
    }
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return 'rowgroup';
    case 'dialog':
      return 'dialog';
    case 'progress':
      return 'progressbar';
    case 'output':
      return 'status';
    case 'hr':
      return 'separator';
    case 'fieldset':
      return 'group';
    case 'figure':
      return 'figure';
    case 'blockquote':
      return 'blockquote';
    case 'textarea':
      return 'textbox';
    case 'img': {
      // `<img alt="" role="presentation">` is a deliberate belt-and-braces idiom, so
      // only the positive case counts as redundant.
      const altAttr = getAttr(el, 'alt');
      if (altAttr !== undefined && !isDynamic(altAttr) && altAttr.value === '') return undefined;
      return 'img';
    }
    case 'section': {
      // A <section> is only a region once it has an accessible name.
      const named = hasAttr(el, 'aria-label') || hasAttr(el, 'aria-labelledby');
      return named ? 'region' : undefined;
    }
    case 'header':
    case 'footer': {
      for (let p = el.parent; p !== null; p = p.parent) {
        if (SECTIONING_TAGS.has(p.tagLower)) return undefined;
      }
      return tag === 'header' ? 'banner' : 'contentinfo';
    }
    case 'input': {
      const type = literalValue(getAttr(el, 'type'));
      if (getAttr(el, 'type') !== undefined && type === null) return undefined; // dynamic type
      switch ((type ?? 'text').toLowerCase()) {
        case 'checkbox': return 'checkbox';
        case 'radio': return 'radio';
        case 'range': return 'slider';
        case 'number': return 'spinbutton';
        case 'search': return hasAttr(el, 'list') ? undefined : 'searchbox';
        case 'button':
        case 'submit':
        case 'reset':
        case 'image': return 'button';
        case 'text':
        case 'email':
        case 'tel':
        case 'url': return hasAttr(el, 'list') ? undefined : 'textbox';
        default: return undefined;
      }
    }
    default:
      return undefined;
  }
}

const redundantRole: Rule = {
  id: 'A11Y-ARIA-003',
  title: 'role duplicates the element’s native semantics',
  wcag: [],
  level: 'A',
  severity: 'info',
  summary: 'Flags roles such as role="button" on <button> that add nothing.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (isComponent(el)) continue; // <Button role="button"> renders who-knows-what
      const attr = getAttr(el, 'role');
      if (attr === undefined || isDynamic(attr)) continue;
      const tokens = roleTokens(el);
      if (tokens === null || tokens.length !== 1) continue;
      const role = tokens[0] as string;
      const native = implicitRole(el);
      if (native === undefined || native !== role) continue;

      out.push(
        report(ctx, {
          ruleId: redundantRole.id,
          wcag: [],
          level: 'A',
          severity: 'info',
          start: attr.nameStart,
          end: attr.valueEnd,
          message: `<${el.tag}> already has the role "${role}"; the role attribute repeats it.`,
          impact:
            'Nothing is announced differently, so no one is blocked. The cost is maintenance: ' +
            'the explicit role has to be kept in step with the element, and it hides the fact ' +
            'that the native semantics were already correct.',
        }, makeFix(
          'review',
          `Remove the redundant role="${role}".`,
          [removeAttrEdit(ctx, attr, `remove redundant role="${role}"`)],
        )),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-004 — aria-labelledby / aria-describedby pointing nowhere
// ---------------------------------------------------------------------------

const ID_CHAR = /[-A-Za-z0-9_:.]/;

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * True when the id token occurs somewhere in the file that is not itself one of these
 * references. A hit means the id is at least *mentioned* here — built into a template
 * literal, or written on an element we mis-parsed — so the reference is not provably
 * dangling and we stay quiet.
 *
 * Every reference span is excluded, not just the one being checked. Excluding only the
 * current one lets two elements that point at the same missing id vouch for each other,
 * and the rule then reports nothing precisely when the bug has been copy-pasted.
 */
function tokenAppearsOutside(source: string, token: string, refs: readonly Span[]): boolean {
  let i = source.indexOf(token);
  while (i >= 0) {
    if (!refs.some((r) => i >= r.start && i < r.end)) {
      const before = source[i - 1];
      const after = source[i + token.length];
      const boundedLeft = before === undefined || !ID_CHAR.test(before);
      const boundedRight = after === undefined || !ID_CHAR.test(after);
      if (boundedLeft && boundedRight) return true;
    }
    i = source.indexOf(token, i + 1);
  }
  return false;
}

const danglingIdRef: Rule = {
  id: 'A11Y-ARIA-004',
  title: 'aria-labelledby / aria-describedby must reference an existing id',
  wcag: WCAG_412,
  level: 'A',
  severity: 'error',
  summary: 'Flags label and description references whose target id is nowhere in the file.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const ids = new Set<string>();
    const refs: Span[] = [];
    for (const el of ctx.markup.elements) {
      const value = literalValue(getAttr(el, 'id'));
      if (value !== null && value.trim() !== '') ids.add(value.trim());
      for (const name of ['aria-labelledby', 'aria-describedby'] as const) {
        const attr = getAttr(el, name);
        if (attr !== undefined) refs.push({ start: attr.valueStart, end: attr.valueEnd });
      }
    }
    // Answers are cached because the same id is usually referenced from several places,
    // and each miss costs a scan of the whole file.
    const seen = new Map<string, boolean>();
    const appearsOutside = (token: string): boolean => {
      const cached = seen.get(token);
      if (cached !== undefined) return cached;
      const found = tokenAppearsOutside(ctx.source, token, refs);
      seen.set(token, found);
      return found;
    };

    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      for (const name of ['aria-labelledby', 'aria-describedby'] as const) {
        const attr = getAttr(el, name);
        if (attr === undefined) continue;
        const naming = name === 'aria-labelledby';

        if (isDynamic(attr)) continue; // the ids are computed; nothing to verify here
        const raw = attr.value;
        if (raw === null) continue; // `aria-labelledby` bare is the JSX boolean shorthand

        if (raw.trim() === '') {
          out.push(
            report(ctx, {
              ruleId: danglingIdRef.id,
              wcag: WCAG_412,
              level: 'A',
              severity: 'error',
              start: attr.nameStart,
              end: attr.valueEnd,
              message: `<${el.tag}> has an empty ${name}.`,
              impact: naming
                ? 'An empty aria-labelledby resolves to no name at all, and it overrides any other ' +
                  'labelling on the element. The control is announced only by its role — "button", ' +
                  'nothing more.'
                : 'An empty aria-describedby provides no description, so the extra guidance the ' +
                  'author meant to attach is never spoken.',
            }, advice(
              `Point ${name} at the id of the element that carries the text, or remove it.`,
              `Set ${name} to the id of the element holding the text, or delete the attribute.`,
            )),
          );
          continue;
        }

        const missing = tokensOf(raw).filter((t) => !ids.has(t) && !appearsOutside(t));
        if (missing.length === 0) continue;

        const list = missing.map((m) => `"${m}"`).join(', ');
        out.push(
          report(ctx, {
            ruleId: danglingIdRef.id,
            wcag: WCAG_412,
            level: 'A',
            severity: 'error',
            start: attr.nameStart,
            end: attr.valueEnd,
            message: `<${el.tag}> has ${name}=${JSON.stringify(raw)} but no element with the id ${list} exists in this file.`,
            impact: naming
              ? 'A reference that resolves to nothing produces an accessible name of "" — and it ' +
                'still overrides aria-label and the element’s own text. The control is announced ' +
                'as its bare role, while every automated checker reports it as labelled.'
              : 'The description is never announced, so the hint or error text the author attached ' +
                'is invisible to screen reader users.',
          }, advice(
            `Give the intended element id=${JSON.stringify(missing[0] as string)}, or correct the reference.`,
            'Only a human knows which element was meant to carry this text, so no patch is generated. ' +
              'Check whether the id lives in another file before changing anything.',
          )),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-005 — aria-label and aria-labelledby on the same element
// ---------------------------------------------------------------------------

const labelAndLabelledby: Rule = {
  id: 'A11Y-ARIA-005',
  title: 'aria-label is dead code next to aria-labelledby',
  wcag: WCAG_412,
  level: 'A',
  severity: 'warning',
  summary: 'Flags elements carrying both aria-label and aria-labelledby.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const label = getAttr(el, 'aria-label');
      const labelledby = getAttr(el, 'aria-labelledby');
      if (label === undefined || labelledby === undefined) continue;
      // `aria-labelledby={maybeUndefined}` deliberately falls back to aria-label in
      // React, so only a value that is definitely present makes the label dead.
      if (isDynamic(labelledby) || labelledby.value === null || labelledby.value.trim() === '') continue;

      const shown = isDynamic(label) ? '(expression)' : JSON.stringify(label.value ?? '');
      out.push(
        report(ctx, {
          ruleId: labelAndLabelledby.id,
          wcag: WCAG_412,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `<${el.tag}> has both aria-labelledby and aria-label=${shown}; aria-labelledby wins.`,
          impact:
            'The aria-label text is never spoken, so whichever of the two is actually correct is ' +
            'a coin flip for the reader of the code. When the two disagree, the name a screen ' +
            'reader announces is not the one most developers would predict from the source.',
        }, advice(
          'Keep one labelling mechanism.',
          'Delete aria-label if the referenced element already holds the right text; otherwise ' +
            'delete aria-labelledby and keep the literal label. Both carry human-authored text, ' +
            'so this tool will not choose for you.',
        )),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-006 — a name on something that cannot be named
// ---------------------------------------------------------------------------

/** Any attribute that makes the element interactive, and therefore not merely generic. */
function looksInteractive(el: Element): boolean {
  if (hasAttr(el, 'tabindex') || hasAttr(el, 'href') || hasAttr(el, 'contenteditable')) return true;
  return el.attrs.some((a) => {
    const n = a.nameLower;
    return n.startsWith('on') || n.startsWith('@') || n.startsWith('v-on:');
  });
}

const unnameableElement: Rule = {
  id: 'A11Y-ARIA-006',
  title: 'aria-label on an element whose role cannot carry a name',
  wcag: WCAG_412,
  level: 'A',
  severity: 'warning',
  summary: 'Flags accessible names that the platform discards, such as aria-label on role="presentation".',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const label = getAttr(el, 'aria-label');
      const labelledby = getAttr(el, 'aria-labelledby');
      const naming = label ?? labelledby;
      if (naming === undefined) continue;
      // An empty literal label is a "no name" problem, not a "wrong place" problem.
      if (label !== undefined && !isDynamic(label) && (label.value ?? '') === '' && labelledby === undefined) {
        continue;
      }

      const role = effectiveRole(el);
      if (role !== undefined) {
        if (!NAME_PROHIBITED_ROLES.has(role)) continue;
        const removed = role === 'presentation' || role === 'none';
        out.push(
          report(ctx, {
            ruleId: unnameableElement.id,
            wcag: WCAG_412,
            level: 'A',
            severity: 'warning',
            start: el.openStart,
            end: el.openEnd,
            message: `<${el.tag}> has role="${role}", which cannot carry an accessible name, together with ${naming.name}.`,
            impact: removed
              ? 'role="presentation" removes the element from the accessibility tree, so the label ' +
                'is discarded with it. A screen reader announces nothing here, while the source ' +
                'suggests the element is labelled.'
              : 'Naming is prohibited for this role, so the label is dropped. Nothing is announced ' +
                'and the intent is lost.',
          }, advice(
            'Decide whether the element should be exposed or hidden.',
            removed
              ? `Give the element a role that supports naming (role="img", role="group", role="region"…) ` +
                `and keep ${naming.name}, or drop ${naming.name} because the element really is decorative.`
              : `Move ${naming.name} to an element with a role that supports naming.`,
          )),
        );
        continue;
      }

      // No role at all: only generic HTML elements are a problem, and only when they
      // are not standing in for a control (that case belongs to the widget rules).
      if (isComponent(el)) continue;
      if (!GENERIC_TAGS.has(el.tagLower)) continue;
      if (looksInteractive(el)) continue;

      out.push(
        report(ctx, {
          ruleId: unnameableElement.id,
          wcag: WCAG_412,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `<${el.tag}> has ${naming.name} but no role, so it has nothing to name.`,
          impact:
            'A generic element has no role for a name to attach to, and most screen readers ignore ' +
            'the label entirely. The text is announced by no one, and a checker that only looks for ' +
            'the presence of aria-label reports the element as fixed.',
        }, advice(
          `Give the element a role, or move ${naming.name} to the element that has one.`,
          'For example role="img" for a decorative graphic, role="group" for a related set of ' +
            'controls, or role="status" for a live region — whichever matches what this element is.',
        )),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-007 — required parent role missing
// ---------------------------------------------------------------------------

/** Ancestor roles a browser supplies from the HTML element itself. */
function implicitContextRole(el: Element): string | undefined {
  switch (el.tagLower) {
    case 'ul':
    case 'ol':
    case 'menu':
      return 'list';
    case 'select':
    case 'datalist':
      return 'listbox';
    case 'table':
      return 'table';
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return 'rowgroup';
    case 'tr':
      return 'row';
    case 'fieldset':
    case 'optgroup':
      return 'group';
    default:
      return undefined;
  }
}

const missingRequiredParent: Rule = {
  id: 'A11Y-ARIA-007',
  title: 'role requires an ancestor with a specific role',
  wcag: WCAG_131,
  level: 'A',
  severity: 'error',
  summary: 'Flags role="option", role="tab" and similar outside the container their role requires.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    // aria-owns can graft the missing parent on from anywhere in the document, so a
    // file that uses it is not one we can reason about structurally.
    if (ctx.source.includes('aria-owns')) return [];

    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const role = effectiveRole(el);
      if (role === undefined) continue;
      const required = REQUIRED_CONTEXT[role];
      if (required === undefined) continue;

      // A top-level element is a fragment by definition: its real parent is elsewhere.
      if (el.parent === null) continue;

      let found = false;
      let opaque = false;
      for (let p: Element | null = el.parent; p !== null; p = p.parent) {
        // A component or a slot may render the required container around us.
        if (isComponent(p) || p.tagLower === 'slot' || p.tagLower === 'template') {
          opaque = true;
          break;
        }
        const roleAttr = getAttr(p, 'role');
        if (roleAttr !== undefined && isDynamic(roleAttr)) {
          opaque = true;
          break;
        }
        const parentRole = effectiveRole(p) ?? implicitContextRole(p);
        if (parentRole !== undefined && required.includes(parentRole)) {
          found = true;
          break;
        }
      }
      if (found || opaque) continue;

      const list = required.map((r) => `role="${r}"`).join(' or ');
      out.push(
        report(ctx, {
          ruleId: missingRequiredParent.id,
          wcag: WCAG_131,
          level: 'A',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message: `<${el.tag}> has role="${role}" but no ancestor in this file has ${list}.`,
          impact:
            `Without its container the role is incoherent: a screen reader cannot say "${role} 1 of 5" ` +
            'because there is no set to count, and in browse mode the item may not be reachable by ' +
            'the shortcut keys that navigate that widget at all.',
        }, advice(
          `Wrap this element in a container with ${list}.`,
          'The container may legitimately live in another component, in which case this is a false ' +
            'positive — no patch is generated for that reason.',
        )),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-008 — boolean attribute with a non-boolean value
// ---------------------------------------------------------------------------

const nonBooleanAriaValue: Rule = {
  id: 'A11Y-ARIA-008',
  title: 'boolean aria-* attribute must be "true" or "false"',
  wcag: WCAG_412,
  level: 'A',
  severity: 'error',
  summary: 'Flags values such as aria-expanded="yes" or aria-hidden="1" that ARIA does not accept.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      for (const attr of el.attrs) {
        const name = attr.nameLower;
        if (!BOOLEAN_ARIA.has(name)) continue;
        const allowed = ARIA_TOKENS[name];
        if (allowed === undefined) continue;
        const raw = literalValue(attr);
        if (raw === null) continue; // expression, or the JSX boolean shorthand
        if (allowed.includes(raw)) continue;

        const lower = raw.trim().toLowerCase();
        const base = {
          ruleId: nonBooleanAriaValue.id,
          wcag: WCAG_412,
          level: 'A' as const,
          severity: 'error' as const,
          start: attr.nameStart,
          end: attr.valueEnd,
          message: `<${el.tag}> has ${attr.name}=${JSON.stringify(raw)}; ARIA accepts only ${allowed.join(', ')}.`,
          impact:
            `An unparseable value falls back to the default state, so ${name} reports the opposite ` +
            'of what the markup says as often as not. A screen reader announces a collapsed menu as ' +
            'expanded, or reads out content the author believed was hidden.',
        };

        let corrected: string | undefined;
        if (allowed.includes(lower)) corrected = lower;             // case or stray whitespace
        else if (TRUTHY.has(lower) && allowed.includes('true')) corrected = 'true';
        else if (FALSY.has(lower) && allowed.includes('false')) corrected = 'false';

        if (corrected !== undefined) {
          out.push(
            report(ctx, base, makeFix(
              'review',
              `Set ${attr.name} to "${corrected}".`,
              [replaceValueEdit(attr, corrected, `${attr.name}=${JSON.stringify(raw)} → "${corrected}"`)],
            )),
          );
          continue;
        }

        out.push(
          report(ctx, base, advice(
            `${attr.name} needs one of: ${allowed.join(', ')}.`,
            `The value ${JSON.stringify(raw)} does not map onto a boolean, so the intended state is a guess. ` +
              'Set it explicitly, or remove the attribute if the state is not meaningful here.',
          )),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-009 — aria-hidden hiding the page
// ---------------------------------------------------------------------------

/** Cheap, backtracking-free test for an h1 somewhere inside a chunk of source. */
const H1_OPEN = /<h1[\s/>]/i;

const ariaHiddenOnLandmark: Rule = {
  id: 'A11Y-ARIA-009',
  title: 'aria-hidden must not hide the page or its heading',
  wcag: ['1.3.1', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'Flags aria-hidden="true" on <body>, <main>, or a container holding the page heading.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const attr = getAttr(el, 'aria-hidden');
      if (attr === undefined || isDynamic(attr)) continue;
      // Only the literal "true" hides anything; a malformed value is A11Y-ARIA-008's job.
      if (attr.value !== 'true') continue;

      const tag = el.tagLower;
      const isRoot = tag === 'body' || tag === 'main' || effectiveRole(el) === 'main';

      if (isRoot) {
        out.push(
          report(ctx, {
            ruleId: ariaHiddenOnLandmark.id,
            wcag: ['1.3.1', '4.1.2'],
            level: 'A',
            severity: 'error',
            start: attr.nameStart,
            end: attr.valueEnd,
            message: `<${el.tag}> is marked aria-hidden="true", which hides the whole ${tag === 'body' ? 'page' : 'main content'} from assistive technology.`,
            impact:
              'Everything inside is removed from the accessibility tree. A screen reader user reaches ' +
              'the page and finds an empty document — no headings, no links, no text — even though the ' +
              'page renders normally for everyone else.',
          }, makeFix(
            'review',
            `Remove aria-hidden="true" from <${el.tag}>.`,
            [removeAttrEdit(ctx, attr, `remove aria-hidden="true" from <${el.tag}>`)],
          )),
        );
        continue;
      }

      if (!H1_OPEN.test(el.innerSource)) continue;
      out.push(
        report(ctx, {
          ruleId: ariaHiddenOnLandmark.id,
          wcag: ['1.3.1', '4.1.2'],
          level: 'A',
          severity: 'error',
          start: attr.nameStart,
          end: attr.valueEnd,
          message: `<${el.tag}> is marked aria-hidden="true" and contains the page’s <h1>.`,
          impact:
            'The main heading disappears from the accessibility tree, so the shortcut most screen ' +
            'reader users press first — jump to heading — finds nothing, and the page has no ' +
            'announced title to orient by.',
        }, advice(
          'Move aria-hidden onto the decorative part, or remove it.',
          'This is often a modal-backdrop pattern where the attribute is meant to be toggled at ' +
            'runtime rather than written in the source. No patch is generated because removing it ' +
            'may not be the change you want.',
        )),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-010 — role="img" with nothing to announce
// ---------------------------------------------------------------------------

const imgRoleWithoutName: Rule = {
  id: 'A11Y-ARIA-010',
  title: 'role="img" requires an accessible name',
  wcag: ['1.1.1'],
  level: 'A',
  severity: 'error',
  summary: 'Flags role="img" elements that expose an image with no text alternative.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      // <img> is named by alt, which the image rules own; role="img" there is redundant
      // (A11Y-ARIA-003) rather than unnamed.
      if (el.tagLower === 'img') continue;
      if (effectiveRole(el) !== 'img') continue;

      const label = getAttr(el, 'aria-label');
      const hasLabel = label !== undefined && (isDynamic(label) || (label.value ?? '').trim() !== '');
      const labelledby = getAttr(el, 'aria-labelledby');
      const hasLabelledby = labelledby !== undefined && (isDynamic(labelledby) || (labelledby.value ?? '').trim() !== '');
      const title = getAttr(el, 'title');
      const hasTitle = title !== undefined && (isDynamic(title) || (title.value ?? '').trim() !== '');
      // <svg role="img"><title>…</title></svg> is the canonical named-SVG pattern.
      const hasSvgTitle = el.children.some((c) => c.tagLower === 'title' && textOf(c) !== '');
      if (hasLabel || hasLabelledby || hasTitle || hasSvgTitle) continue;

      const base = {
        ruleId: imgRoleWithoutName.id,
        wcag: ['1.1.1'],
        level: 'A' as const,
        severity: 'error' as const,
        start: el.openStart,
        end: el.openEnd,
        message: `<${el.tag}> has role="img" but no accessible name.`,
        impact:
          'role="img" tells a screen reader that this is a picture and that its children are not ' +
          'to be read, so with no name the user is told an image is here and nothing about what it ' +
          'shows. Whatever the graphic communicates is simply lost.',
      };

      // The name is human knowledge. We mark the spot with a value that fails CI rather
      // than inventing a description that would silently lie to the reader.
      const edit = label === undefined
        ? insertAttrEdit(ctx, el, `aria-label="${TODO_MARKER}: describe this image"`,
          `add placeholder aria-label to <${el.tag}>`)
        : null;

      if (edit === null) {
        out.push(report(ctx, base, advice(
          'Add an aria-label describing what the image conveys.',
          `Only someone who can see the graphic can write this. Use <svg role="img"><title>…</title>` +
            ' for inline SVG, or role="presentation" if the image is decorative.',
        )));
        continue;
      }

      // No advisory is attached: `fixAllowed` reads an advisory as "advice only, never
      // apply", and the entire point of the placeholder is that it lands in the file and
      // fails CI until a human replaces it.
      out.push(report(ctx, base, makeFix(
        'manual',
        `Insert a placeholder aria-label containing ${TODO_MARKER}. It is not a description: ` +
          'it fails CI until someone who has seen the image writes the real text. If the image ' +
          'is decorative, use role="presentation" instead of naming it.',
        [edit],
      )));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-011 — attribute the role does not support
// ---------------------------------------------------------------------------

const unsupportedAriaForRole: Rule = {
  id: 'A11Y-ARIA-011',
  title: 'aria-* attribute is not supported by the element’s role',
  wcag: WCAG_412,
  level: 'A',
  severity: 'warning',
  summary: 'Flags state and property attributes that the declared role ignores, such as aria-checked on role="link".',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const role = effectiveRole(el);
      if (role === undefined) continue;
      const supported = ROLE_SUPPORTED[role];
      if (supported === undefined) continue; // no data for this role: say nothing

      for (const attr of el.attrs) {
        const name = attr.nameLower;
        if (!name.startsWith('aria-')) continue;
        if (!VALID_ARIA.has(name)) continue;        // A11Y-ARIA-002 owns unknown names
        if (GLOBAL_ARIA.has(name)) continue;        // allowed on every role
        if (supported.includes(name)) continue;

        out.push(
          report(ctx, {
            ruleId: unsupportedAriaForRole.id,
            wcag: WCAG_412,
            level: 'A',
            severity: 'warning',
            start: attr.nameStart,
            end: attr.valueEnd,
            message: `<${el.tag}> has role="${role}", which does not support ${attr.name}.`,
            impact:
              'The attribute is not mapped for this role, so the state it describes is never ' +
              'announced. The element looks stateful in the source and is announced as inert, ' +
              'which usually means the role is wrong rather than the attribute.',
          }, advice(
            `Either change the role or drop ${attr.name}.`,
            supported.length > 0
              ? `role="${role}" supports ${supported.join(', ')} plus the global attributes. ` +
                'Removing the attribute silences a real intent, so this is left for you to decide.'
              : `role="${role}" supports only the global ARIA attributes. Removing the attribute ` +
                'silences a real intent, so this is left for you to decide.',
          )),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-ARIA-012 — value outside the attribute's allowed set
// ---------------------------------------------------------------------------

const INTEGER_VALUE = /^-?\d+$/;
const NUMBER_VALUE = /^-?\d+(?:\.\d+)?$/;

const invalidAriaValue: Rule = {
  id: 'A11Y-ARIA-012',
  title: 'aria-* value must match the attribute’s value type',
  wcag: WCAG_412,
  level: 'A',
  severity: 'warning',
  summary: 'Flags enumerated, numeric and token-list aria-* values that ARIA does not accept.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      for (const attr of el.attrs) {
        const name = attr.nameLower;
        if (!name.startsWith('aria-') || !VALID_ARIA.has(name)) continue;
        if (BOOLEAN_ARIA.has(name)) continue; // A11Y-ARIA-008 owns those
        const raw = literalValue(attr);
        if (raw === null) continue;
        const value = raw.trim();
        if (value === '') continue; // an empty value is the "unset" idiom, not a wrong value

        const base = (message: string, impact: string) => ({
          ruleId: invalidAriaValue.id,
          wcag: WCAG_412,
          level: 'A' as const,
          severity: 'warning' as const,
          start: attr.nameStart,
          end: attr.valueEnd,
          message,
          impact,
        });

        const allowed = ARIA_TOKENS[name];
        if (allowed !== undefined) {
          if (allowed.includes(raw)) continue;
          const lower = value.toLowerCase();
          const near = allowed.includes(lower) ? [lower] : nearMatches(lower, allowed);
          const info = base(
            `<${el.tag}> has ${attr.name}=${JSON.stringify(raw)}; allowed values are ${allowed.join(', ')}.`,
            `An unrecognised value is ignored and ${name} falls back to its default, so the ` +
              'behaviour the author asked for — an announcement, a sort order, a current-page ' +
              'marker — never happens, silently.',
          );
          if (near.length === 1) {
            const suggestion = near[0] as string;
            out.push(report(ctx, info, makeFix(
              'review',
              `Set ${attr.name} to "${suggestion}".`,
              [replaceValueEdit(attr, suggestion, `${attr.name}=${JSON.stringify(raw)} → "${suggestion}"`)],
            )));
          } else {
            out.push(report(ctx, info, advice(
              `${attr.name} needs one of: ${allowed.join(', ')}.`,
              'The intended value cannot be inferred from what is written, so no patch is generated.',
            )));
          }
          continue;
        }

        const tokenList = ARIA_TOKEN_LISTS[name];
        if (tokenList !== undefined) {
          const bad = tokensOf(value).filter((t) => !tokenList.includes(t.toLowerCase()));
          if (bad.length === 0) continue;
          out.push(report(ctx, base(
            `<${el.tag}> has ${attr.name}=${JSON.stringify(raw)}; ${bad.map((b) => `"${b}"`).join(', ')} is not an allowed token.`,
            'The whole attribute is discarded when a token is unrecognised, so the live-region ' +
              'behaviour it configures reverts to the default and updates are announced at the ' +
              'wrong time, or not at all.',
          ), advice(
            `Use one or more of: ${tokenList.join(', ')}.`,
            'Tokens are space separated and case sensitive.',
          )));
          continue;
        }

        const integer = ARIA_INTEGER.has(name);
        if (integer || ARIA_NUMBER.has(name)) {
          const pattern = integer ? INTEGER_VALUE : NUMBER_VALUE;
          if (pattern.test(value)) continue;
          out.push(report(ctx, base(
            `<${el.tag}> has ${attr.name}=${JSON.stringify(raw)}, which is not ${integer ? 'an integer' : 'a number'}.`,
            'A value that will not parse is dropped, so a heading announces no level, or a slider ' +
              'reports no position — the user hears the control but not where they are in it.',
          ), advice(
            `Write ${attr.name} as ${integer ? 'a plain integer' : 'a plain number'}, with no units or symbols.`,
            'Percent signs, "px" and similar suffixes make the value invalid.',
          )));
        }
      }
    }
    return out;
  },
};

export const RULES: readonly Rule[] = [
  invalidRole,
  unknownAriaAttribute,
  redundantRole,
  danglingIdRef,
  labelAndLabelledby,
  unnameableElement,
  missingRequiredParent,
  nonBooleanAriaValue,
  ariaHiddenOnLandmark,
  imgRoleWithoutName,
  unsupportedAriaForRole,
  invalidAriaValue,
];
