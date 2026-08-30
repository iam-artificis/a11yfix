import type { Attr, Element } from '../parse/markup.js';
import type { Edit, Fix, FixSafety, Rule, RuleContext, Violation } from '../types.js';
import { TODO_MARKER } from '../types.js';
import { getAttr, hasAttr, textOf } from '../parse/markup.js';

/**
 * Keyboard and focus.
 *
 * Everything here is about the same question: can a person who never touches a mouse
 * reach this control, tell what it is, and operate it? The failures are cheap to make
 * (a `div` with an `onClick`) and total in effect — the control simply does not exist
 * for that user, and no amount of colour contrast or alt text compensates.
 *
 * Two judgements shape the fixes in this file:
 *
 * 1. Focusability can be patched; behaviour cannot. We can add `tabindex` and `role`
 *    because there is one right answer for each. We cannot write the key handler that
 *    makes Enter and Space activate the thing, because that is application code. So the
 *    rules that need a handler emit advice, not edits — a patch that makes an element
 *    focusable but still inert would move the bug rather than fix it, which is why the
 *    fix description always names the handler that is still missing.
 * 2. A native element is better than any patch we can write. `role="button"` plus
 *    `tabindex="0"` reproduces about a third of what `<button>` gives for free (focus,
 *    Enter/Space, disabled, form submission, forced-colours styling). Every message in
 *    this file says so, because the patch is a floor and not the goal.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Tags that carry no interactive semantics, so a click handler on one is a control
 * that only a mouse can see. Deliberately short: a false positive here proposes a
 * `role` on an element whose author may have meant nothing of the kind.
 */
const NON_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'div', 'span', 'p', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'figure', 'li', 'td', 'th', 'tr', 'dt', 'dd', 'ul', 'ol', 'dl', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/** Tags that provide a landmark, which `role="button"` would take away. */
const LANDMARK_TAGS: ReadonlySet<string> = new Set([
  'main', 'nav', 'header', 'footer', 'aside', 'section', 'article', 'figure',
]);

/**
 * Non-interactive tags that already carry semantics of their own, which `role="button"`
 * would replace rather than add to.
 *
 * A `<li>` or `<td>` silently drops out of its list or table, leaving the owning element
 * with children of the wrong role. An `<h2>` disappears from the heading outline, which
 * is the primary way a screen-reader user moves through a page. A `<main>` or `<nav>`
 * stops being a landmark. In every case the patch trades one bug for another, so these
 * get advice to nest a real `<button>` instead.
 *
 * What is left patchable — `div`, `span`, `p` — is exactly the "div as button" case,
 * where there is no existing semantic to destroy.
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'li', 'td', 'th', 'tr', 'dt', 'dd', 'ul', 'ol', 'dl', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  ...LANDMARK_TAGS,
]);

/** What putting `role="button"` on this tag would cost, for the advisory message. */
function semanticsLostByRole(tagLower: string): string {
  if (/^h[1-6]$/.test(tagLower)) {
    return 'its heading level, which is the main way a screen-reader user navigates a page';
  }
  if (LANDMARK_TAGS.has(tagLower)) return 'the landmark it contributes to the page outline';
  return 'its place in the surrounding list or table, which a screen reader announces';
}

/** Roles that make a descendant a control in its own right. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton',
]);

const KEY_EVENTS: ReadonlySet<string> = new Set(['keydown', 'keyup', 'keypress']);

/**
 * Roles whose owner manages focus with a roving tabindex, so `tabindex="-1"` on a
 * child is the correct implementation rather than a mistake.
 */
const COMPOSITE_ROLES: ReadonlySet<string> = new Set([
  'tablist', 'menu', 'menubar', 'listbox', 'radiogroup', 'toolbar',
  'grid', 'treegrid', 'tree', 'combobox', 'group', 'row',
]);

const MANAGED_ROLES: ReadonlySet<string> = new Set([
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
  'treeitem', 'gridcell', 'columnheader', 'rowheader',
]);

// ---------------------------------------------------------------------------
// Reading the markup
// ---------------------------------------------------------------------------

/** JSX component, not an HTML element: we cannot know what props it forwards. */
function isComponentTag(el: Element): boolean {
  return /^[A-Z]/.test(el.tag);
}

/**
 * Attribute lookup that also matches the bound spellings of the same attribute —
 * Vue's `:href` and `v-bind:href`, Svelte's `bind:value`.
 *
 * Every presence check in this file goes through here. `<a :href="url">` has an href;
 * finding only the literal spelling would report a working link as unfocusable, and
 * would let a second `tabindex` be inserted next to a bound one.
 */
function getAttrLoose(el: Element, name: string): Attr | undefined {
  const lower = name.toLowerCase();
  const exact = getAttr(el, lower);
  if (exact !== undefined) return exact;
  return el.attrs.find((a) => {
    const n = a.nameLower;
    return n === ':' + lower || n === 'v-bind:' + lower || n === 'bind:' + lower;
  });
}

function hasAttrLoose(el: Element, name: string): boolean {
  return hasAttr(el, name) || getAttrLoose(el, name) !== undefined;
}

/** True when the value is a literal we may rewrite, rather than an expression. */
function isStaticValue(a: Attr): boolean {
  return !a.dynamic && a.quote !== '{';
}

/**
 * The element's role, lowercased, or null when there is none or it is computed.
 * ARIA accepts a fallback list (`role="doc-subtitle heading"`); the first token wins.
 */
function roleOf(el: Element): string | null {
  const a = getAttrLoose(el, 'role');
  if (a === undefined || a.value === null || !isStaticValue(a)) return null;
  const first = a.value.trim().toLowerCase().split(/\s+/)[0];
  return first === undefined || first === '' ? null : first;
}

/**
 * The declared tabindex as a number, or null when absent or not a plain integer.
 *
 * A JSX `tabIndex={0}` is marked dynamic but its value text is still the literal `0`,
 * so it is safe to *read* here. It is never safe to *write*: see `RULES OF SAFETY`.
 */
function tabIndexValue(el: Element): number | null {
  const a = getAttrLoose(el, 'tabindex');
  if (a === undefined || a.value === null) return null;
  const raw = a.value.trim();
  if (!/^[+-]?\d{1,6}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * The DOM event an attribute listens for, across the four dialects we parse:
 * `onclick`/`onClick` (HTML, JSX, Svelte 5), `@click` and `v-on:click` (Vue),
 * `on:click` (Svelte 4). Modifier suffixes (`@click.prevent`, `on:click|once`) and
 * React's capture variant are stripped so callers can compare plain event names.
 */
function eventOf(a: Attr): string | null {
  let n = a.nameLower;
  if (n.startsWith('v-on:')) n = n.slice(5);
  else if (n.startsWith('@')) n = n.slice(1);
  else if (n.startsWith('on:')) n = n.slice(3);
  else if (n.length > 2 && n.startsWith('on')) n = n.slice(2);
  else return null;

  const dot = n.indexOf('.');
  if (dot >= 0) n = n.slice(0, dot);
  const pipe = n.indexOf('|');
  if (pipe >= 0) n = n.slice(0, pipe);
  if (n.length > 7 && n.endsWith('capture')) n = n.slice(0, -7);
  return n === '' ? null : n;
}

function clickAttrOf(el: Element): Attr | undefined {
  return el.attrs.find((a) => eventOf(a) === 'click');
}

function hasKeyHandler(el: Element): boolean {
  return el.attrs.some((a) => {
    const e = eventOf(a);
    return e !== null && KEY_EVENTS.has(e);
  });
}

/** Tags the browser puts in the tab order without any help from the author. */
function isNativelyFocusable(el: Element): boolean {
  switch (el.tagLower) {
    case 'a':
    case 'area':
      return hasAttrLoose(el, 'href');
    case 'button':
    case 'select':
    case 'textarea':
    case 'iframe':
    case 'summary':
      return true;
    case 'input': {
      const type = getAttr(el, 'type');
      const value = type?.value?.trim().toLowerCase();
      return value !== 'hidden';
    }
    default:
      return false;
  }
}

/** Attributes that take an element out of the tab order regardless of anything else. */
function isInertLike(el: Element): boolean {
  return hasAttrLoose(el, 'disabled') || hasAttrLoose(el, 'inert') || hasAttrLoose(el, 'hidden');
}

/** Best static guess at whether a keyboard user can land on this element. */
function isFocusable(el: Element): boolean {
  if (isInertLike(el)) return false;
  const declared = tabIndexValue(el);
  if (declared !== null) return declared >= 0;
  // A tabindex we cannot read is an unknown, not a zero: do not guess either way.
  if (hasAttrLoose(el, 'tabindex')) return false;
  return !isComponentTag(el) && isNativelyFocusable(el);
}

/** True when an ancestor manages this element's focus with a roving tabindex. */
function inCompositeWidget(el: Element): boolean {
  let node: Element | null = el.parent;
  let hops = 0;
  while (node !== null && hops < 12) {
    const role = roleOf(node);
    if (role !== null && COMPOSITE_ROLES.has(role)) return true;
    node = node.parent;
    hops++;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Writing edits
// ---------------------------------------------------------------------------

/**
 * Offset of the '>' (or '/>') that closes the opening tag — where a new attribute goes.
 * HTML void elements report `selfClosing` without carrying a slash, so the character
 * itself is checked rather than the flag.
 */
function attrInsertPoint(ctx: RuleContext, el: Element): number {
  return el.openEnd - (el.selfClosing && ctx.source[el.openEnd - 2] === '/' ? 2 : 1);
}

/**
 * Insert one or more attributes into the opening tag, spacing them correctly.
 *
 * `text` carries no separators of its own: the surrounding characters decide them, so
 * `<div ... />` does not become `<div ...  role="button"/>` — valid but visibly written
 * by a machine, and a diff nobody wants to approve.
 */
function insertAttrs(ctx: RuleContext, el: Element, text: string, label: string): Edit {
  const at = attrInsertPoint(ctx, el);
  const before = ctx.source[at - 1];
  const padded =
    before === undefined || before === ' ' || before === '\t' || before === '\n' || before === '\r';
  const suffix = ctx.source[at] === '/' ? ' ' : '';
  return { start: at, end: at, replacement: (padded ? '' : ' ') + text + suffix, label };
}

/** Delete an attribute together with the single space that separated it. */
function removeAttr(ctx: RuleContext, a: Attr, label: string): Edit {
  let start = a.nameStart;
  const before = ctx.source[start - 1];
  if (start > 0 && (before === ' ' || before === '\t')) start -= 1;
  return { start, end: a.valueEnd, replacement: '', label };
}

/**
 * Which attribute spelling to emit. JSX needs `tabIndex={0}`; HTML, Vue and Svelte all
 * need `tabindex="0"`. The file extension decides it, with a camelCase `on*` handler as
 * the fallback signal for JSX embedded in a file we cannot classify by name.
 */
function usesJsxSpelling(ctx: RuleContext, el: Element): boolean {
  if (/\.(jsx|tsx|mdx)$/i.test(ctx.file)) return true;
  return el.attrs.some((a) => /^on[A-Z]/.test(a.name));
}

function tabIndexAttrText(ctx: RuleContext, el: Element, value: string): string {
  return usesJsxSpelling(ctx, el) ? `tabIndex={${value}}` : `tabindex="${value}"`;
}

/** Build the violation payload, omitting `fix` entirely when there is none. */
function payload(
  v: Omit<Violation, 'line' | 'column' | 'file' | 'excerpt' | 'fix'>,
  fix: Fix | null,
): Omit<Violation, 'line' | 'column' | 'file' | 'excerpt'> {
  return fix === null ? v : { ...v, fix };
}

const BETTER_AS_BUTTON =
  'A real <button> is better than any combination of role and tabindex: it is focusable, ' +
  'activates on Enter and Space, supports disabled, and keeps working in forced-colours mode.';

// ---------------------------------------------------------------------------
// A11Y-KBD-001 — positive tabindex
// ---------------------------------------------------------------------------

const positiveTabindex: Rule = {
  id: 'A11Y-KBD-001',
  title: 'Positive tabindex',
  wcag: ['2.4.3'],
  level: 'A',
  severity: 'error',
  summary: 'tabindex greater than zero reorders the tab sequence of the entire page.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const attr = getAttrLoose(el, 'tabindex');
      if (attr === undefined) continue;
      const value = tabIndexValue(el);
      if (value === null || value <= 0) continue;

      const meta = {
        ruleId: 'A11Y-KBD-001',
        wcag: ['2.4.3'],
        level: 'A' as const,
        severity: 'error' as const,
        start: attr.nameStart,
        end: attr.valueEnd,
        message:
          `<${el.tag}> has tabindex="${value}". Any value above zero moves the element out of ` +
          'the document order and into a separate, higher-priority tab sequence.',
        impact:
          'A keyboard user pressing Tab from the top of the page lands here first, before the ' +
          'skip link and the navigation, and after this element the sequence jumps back to the ' +
          'beginning. One positive value is enough to make the order of the whole page ' +
          'unpredictable, and every later value has to be maintained in step with it.',
      };

      // A literal `{1}` could be rewritten to `{0}` without breaking the expression, but
      // the rule against editing dynamic values is unconditional for a reason: the next
      // reader of this file cannot tell which braced values we consider safe.
      if (!isStaticValue(attr)) {
        out.push(
          ctx.report(
            payload(meta, {
              safety: 'review',
              edits: [],
              description: 'Set the tab order back to the document order.',
              advisory:
                `Change this computed tabindex to 0 so the element keeps its natural position ` +
                'in the tab order. If the sequence genuinely needs to differ, reorder the ' +
                'markup instead — tab order follows the DOM.',
            }),
          ),
        );
        continue;
      }

      out.push(
        ctx.report(
          payload(meta, {
            safety: 'review',
            edits: [
              {
                start: attr.valueStart,
                end: attr.valueEnd,
                replacement: JSON.stringify('0'),
                label: `tabindex="${value}" -> tabindex="0"`,
              },
            ],
            // Not automatic: inside a hand-rolled widget a positive value can be part of a
            // deliberate (if ill-advised) sequence, and flattening one of several breaks it.
            description:
              'Set tabindex to 0 so the element is focusable in document order. Check whether ' +
              'other elements nearby carry positive values that were meant to work together.',
          }),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-002 — click handler on something a keyboard cannot focus
// ---------------------------------------------------------------------------

const clickHandlerNotFocusable: Rule = {
  id: 'A11Y-KBD-002',
  title: 'Click handler on a non-focusable element',
  wcag: ['2.1.1', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'An element with a click handler that no keyboard user can reach or identify.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (isComponentTag(el)) continue;
      const click = clickAttrOf(el);
      if (click === undefined) continue;
      if (hasAttrLoose(el, 'tabindex')) continue;
      if (isNativelyFocusable(el)) continue;
      if (isInertLike(el)) continue;

      const role = roleOf(el);
      // A computed role reads as `null` here but is not an absent role. Patching an
      // element whose role we cannot evaluate could contradict what it resolves to.
      if (role === null && hasAttrLoose(el, 'role')) continue;
      const jsx = usesJsxSpelling(ctx, el);
      const tabIndexText = tabIndexAttrText(ctx, el, '0');

      // Branch 1: no role at all — the classic "div as button".
      // The trigger is deliberately wider than "also has no key handler": an element with
      // onClick *and* onKeyDown but no tabindex still cannot be reached, and the patch is
      // the same one, so narrowing here would leave a real failure unreported.
      if (role === null) {
        if (!NON_INTERACTIVE_TAGS.has(el.tagLower)) continue;
        const missingKeys = !hasKeyHandler(el);
        const meta = {
          ruleId: 'A11Y-KBD-002',
          wcag: ['2.1.1', '4.1.2'],
          level: 'A' as const,
          severity: 'error' as const,
          start: el.openStart,
          end: el.openEnd,
          message:
            `<${el.tag}> has a ${click.name} handler but no role and no tabindex` +
            (missingKeys ? ' and no keyboard handler' : '') +
            `. It is a control by appearance only. ${BETTER_AS_BUTTON}`,
          impact:
            'The element is not in the tab order, so a keyboard user can never put focus on ' +
            'it, and a screen reader announces it as plain text with no hint that it does ' +
            'anything. The action behind it is reachable with a mouse and by no other means.',
        };

        // A list item or table cell cannot take role="button" without dropping out of the
        // list or table it belongs to, so those get advice rather than an edit.
        if (STRUCTURAL_TAGS.has(el.tagLower)) {
          out.push(
            ctx.report(
              payload(meta, {
                safety: 'review',
                edits: [],
                description: 'Move the interaction into a real control inside this element.',
                advisory:
                  `Wrap the contents of this <${el.tag}> in a <button type="button"> and move ` +
                  `the ${click.name} handler onto it. Putting role="button" on the ` +
                  `<${el.tag}> itself would remove it from the surrounding ` +
                  'list or table, which breaks the structure a screen reader relies on.',
              }),
            ),
          );
          continue;
        }

        out.push(
          ctx.report(
            payload(meta, {
              safety: 'review',
              edits: [
                insertAttrs(
                  ctx,
                  el,
                  `role="button" ${tabIndexText}`,
                  `add role="button" and ${jsx ? 'tabIndex={0}' : 'tabindex="0"'}`,
                ),
              ],
              description:
                'Make the element focusable and announce it as a button. This is a floor, not ' +
                'a finish: it still needs a key handler that activates on Enter and Space, and ' +
                'replacing it with <button> would supply both for free.',
            }),
          ),
        );
        continue;
      }

      // Branch 2: the author declared button/link semantics but never made it focusable.
      if (role !== 'button' && role !== 'link') continue;
      out.push(
        ctx.report(
          payload(
            {
              ruleId: 'A11Y-KBD-002',
              wcag: ['2.1.1', '4.1.2'],
              level: 'A',
              severity: 'error',
              start: el.openStart,
              end: el.openEnd,
              message:
                `<${el.tag}> declares role="${role}" and handles ${click.name}, but has no ` +
                'tabindex, so the browser never puts it in the tab order.',
              impact:
                'A screen-reader user browsing element by element hears a button, tries to ' +
                'move focus to it, and cannot: the promise the role makes is one the element ' +
                'cannot keep. Tab skips straight past it.',
            },
            {
              safety: 'review',
              edits: [
                insertAttrs(
                  ctx,
                  el,
                  tabIndexText,
                  `add ${jsx ? 'tabIndex={0}' : 'tabindex="0"'}`,
                ),
              ],
              description:
                `Add tabindex="0" so the element with role="${role}" can actually receive ` +
                `focus. ${BETTER_AS_BUTTON}`,
            },
          ),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-003 — button/link role with no key handler
// ---------------------------------------------------------------------------

const roleWithoutKeyHandler: Rule = {
  id: 'A11Y-KBD-003',
  title: 'Custom control with no keyboard activation',
  wcag: ['2.1.1'],
  level: 'A',
  severity: 'error',
  summary: 'role="button" or role="link" with a click handler and nothing bound to a key.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (isComponentTag(el)) continue;
      const role = roleOf(el);
      if (role !== 'button' && role !== 'link') continue;
      const click = clickAttrOf(el);
      if (click === undefined) continue;
      if (hasKeyHandler(el)) continue;
      // A native control already activates on Enter (and Space, for button) with no
      // handler of its own; the redundant role does not take that away.
      if (isNativelyFocusable(el)) continue;

      const activation = role === 'button' ? 'Enter and Space' : 'Enter';
      out.push(
        ctx.report(
          payload(
            {
              ruleId: 'A11Y-KBD-003',
              wcag: ['2.1.1'],
              level: 'A',
              severity: 'error',
              start: el.openStart,
              end: el.openEnd,
              message:
                `<${el.tag}> declares role="${role}" and handles ${click.name}, but has no ` +
                'keydown, keyup or keypress handler. A role changes what is announced, not ' +
                'what the element responds to.',
              impact:
                `A keyboard user can focus this element and hears it announced as a ${role}, ` +
                `then presses ${activation} and nothing happens. Focus sits on a control that ` +
                'looks operable and is not, which is more confusing than an element that was ' +
                'never announced at all.',
            },
            {
              // We will not write application code. The handler has to decide what counts as
              // activation, whether to preventDefault, and what to call — none of it visible
              // from the markup.
              safety: 'manual',
              edits: [],
              description: 'Bind keyboard activation to the same action as the click.',
              advisory:
                `Add a keydown handler that runs the same action when the key is ${activation}` +
                (role === 'button'
                  ? ', calling preventDefault for Space so the page does not scroll'
                  : '') +
                `. ${BETTER_AS_BUTTON}`,
            },
          ),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-004 — aria-hidden on a focusable element
// ---------------------------------------------------------------------------

const ariaHiddenFocusable: Rule = {
  id: 'A11Y-KBD-004',
  title: 'aria-hidden on a focusable element',
  wcag: ['4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'An element hidden from assistive technology that is still in the tab order.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const attr = getAttrLoose(el, 'aria-hidden');
      if (attr === undefined || attr.value === null) continue;
      if (attr.value.trim().toLowerCase() !== 'true') continue;
      if (!isFocusable(el)) continue;

      const declared = tabIndexValue(el);
      const why =
        declared !== null && declared >= 0
          ? `tabindex="${declared}"`
          : `<${el.tag}> is focusable by default`;
      const meta = {
        ruleId: 'A11Y-KBD-004',
        wcag: ['4.1.2'],
        level: 'A' as const,
        severity: 'error' as const,
        start: attr.nameStart,
        end: attr.valueEnd,
        message:
          `aria-hidden="true" is set on an element that can still take focus (${why}). ` +
          'aria-hidden removes an element from the accessibility tree; it does not remove it ' +
          'from the tab order.',
        impact:
          'Tab moves focus onto this element and the screen reader has nothing to announce, ' +
          'because as far as it is concerned the element does not exist. The user hears ' +
          'silence, or the previous element repeated, with no way to tell where focus went ' +
          'or what pressing Enter would do.',
      };

      if (!isStaticValue(attr)) {
        out.push(
          ctx.report(
            payload(meta, {
              safety: 'review',
              edits: [],
              description: 'Stop hiding an element that keyboard focus can still reach.',
              advisory:
                'Either drop aria-hidden from this element, or keep it and take the element ' +
                'out of the tab order as well (tabindex="-1", or removing href/disabling the ' +
                'control). The two have to agree.',
            }),
          ),
        );
        continue;
      }

      out.push(
        ctx.report(
          payload(meta, {
            // Removing aria-hidden is the option that never takes functionality away: at
            // worst it re-announces something redundant. Removing focusability instead can
            // strand a real control that only the keyboard could reach.
            safety: 'review',
            edits: [removeAttr(ctx, attr, 'remove aria-hidden="true"')],
            description:
              'Remove aria-hidden so the focusable element is announced. If it was meant to ' +
              'be hidden — a duplicate of something already in the page — keep aria-hidden ' +
              'and add tabindex="-1" instead so it leaves the tab order too.',
          }),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-005 — role="presentation"/"none" on an interactive element
// ---------------------------------------------------------------------------

const presentationOnInteractive: Rule = {
  id: 'A11Y-KBD-005',
  title: 'Presentational role on an interactive element',
  wcag: ['4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'role="presentation" or role="none" on something the keyboard can focus.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const role = roleOf(el);
      if (role !== 'presentation' && role !== 'none') continue;
      const attr = getAttrLoose(el, 'role');
      if (attr === undefined) continue;
      if (!isFocusable(el)) continue;

      const declared = tabIndexValue(el);
      const reason =
        declared !== null && declared >= 0
          ? `it carries tabindex="${declared}"`
          : `<${el.tag}> is focusable by default`;

      out.push(
        ctx.report(
          payload(
            {
              ruleId: 'A11Y-KBD-005',
              wcag: ['4.1.2'],
              level: 'A',
              severity: 'error',
              start: attr.nameStart,
              end: attr.valueEnd,
              message:
                `role="${role}" asks assistive technology to ignore this element, but ` +
                `${reason}. Browsers resolve the conflict by discarding the role, so it has ` +
                'no effect except to mislead whoever reads the source next.',
              impact:
                'A keyboard user still lands on the element, so the intent of the role — to ' +
                'take it out of the accessibility tree — is not achieved. Where a screen ' +
                'reader does honour it, the user reaches a focusable control that is ' +
                'announced as nothing at all.',
            },
            isStaticValue(attr)
              ? {
                  safety: 'review',
                  edits: [removeAttr(ctx, attr, `remove role="${role}"`)],
                  description:
                    'Remove the presentational role, which the browser is already ignoring. ' +
                    'If the element really is decorative, remove what makes it focusable ' +
                    'instead — its tabindex, its href, or the wrapper itself.',
                }
              : {
                  safety: 'review',
                  edits: [],
                  description: 'Resolve the conflict between the role and focusability.',
                  advisory:
                    'This computed role evaluates to a presentational one on a focusable ' +
                    'element. Drop the role, or make the element non-focusable.',
                },
          ),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-006 — accesskey
// ---------------------------------------------------------------------------

const accesskeyPresent: Rule = {
  id: 'A11Y-KBD-006',
  title: 'accesskey attribute',
  wcag: [],
  level: 'A',
  severity: 'warning',
  summary: 'accesskey collides with browser and screen-reader shortcuts.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const attr = getAttrLoose(el, 'accesskey');
      if (attr === undefined) continue;
      const key = attr.value === null ? '' : attr.value.trim();

      const meta = {
        ruleId: 'A11Y-KBD-006',
        wcag: [] as readonly string[],
        level: 'A' as const,
        severity: 'warning' as const,
        start: attr.nameStart,
        end: attr.valueEnd,
        message:
          `<${el.tag}> defines accesskey${key === '' ? '' : `="${key}"`}. The modifier used to ` +
          'trigger it differs by browser and platform, and the page cannot see which ' +
          'combinations the user’s assistive technology has already claimed.',
        impact:
          'Screen readers reserve most single-letter keystrokes for their own navigation, so ' +
          'an accesskey either does nothing or steals a command the user depends on — and ' +
          'nothing in the page tells them the shortcut exists in the first place.',
      };

      if (!isStaticValue(attr)) {
        out.push(
          ctx.report(
            payload(meta, {
              safety: 'review',
              edits: [],
              description: 'Drop the access key.',
              advisory:
                'Remove this accesskey binding. If the page needs shortcuts, offer them from ' +
                'a documented, user-remappable list, as WCAG 2.1.4 requires for single-key ' +
                'shortcuts.',
            }),
          ),
        );
        continue;
      }

      out.push(
        ctx.report(
          payload(meta, {
            safety: 'review',
            edits: [removeAttr(ctx, attr, 'remove accesskey')],
            description:
              'Remove the accesskey. Check first that nothing documents this shortcut to ' +
              'users; if the shortcut is wanted, implement it so it can be turned off or ' +
              'remapped.',
          }),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-007 — autofocus
// ---------------------------------------------------------------------------

const autofocusPresent: Rule = {
  id: 'A11Y-KBD-007',
  title: 'autofocus attribute',
  wcag: [],
  level: 'A',
  severity: 'info',
  summary: 'autofocus moves focus before the user has read anything. Sometimes correct.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const attr = getAttrLoose(el, 'autofocus');
      if (attr === undefined) continue;

      out.push(
        ctx.report(
          payload(
            {
              ruleId: 'A11Y-KBD-007',
              wcag: [],
              level: 'A',
              severity: 'info',
              start: attr.nameStart,
              end: attr.valueEnd,
              message:
                `<${el.tag}> uses autofocus, so focus jumps here as soon as the page loads, ` +
                'past everything above it.',
              impact:
                'A screen-reader user is dropped into the middle of a page they have not ' +
                'heard yet, with no announcement of what was skipped; a magnifier user has ' +
                'the viewport yanked somewhere they did not choose. On a page whose one job ' +
                'is the search box or the login field, this is exactly right — which is why ' +
                'it is reported and never changed automatically.',
            },
            {
              safety: 'manual',
              edits: [],
              description: 'Confirm that focusing this control on load is the intent.',
              advisory:
                'Keep autofocus when the whole purpose of the page is this one field (a search ' +
                'page, a login form, a dialog that just opened). Remove it when the field sits ' +
                'inside a longer page, where jumping past the heading and the navigation costs ' +
                'the user their place.',
            },
          ),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-008 — tabindex="-1" on something with a click handler
// ---------------------------------------------------------------------------

const negativeTabindexWithClick: Rule = {
  id: 'A11Y-KBD-008',
  title: 'Click handler on an element removed from the tab order',
  wcag: ['2.1.1'],
  level: 'A',
  severity: 'warning',
  summary: 'tabindex="-1" plus a click handler, with no other way to reach the action.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (tabIndexValue(el) !== -1) continue;
      const click = clickAttrOf(el);
      if (click === undefined) continue;
      if (isInertLike(el)) continue;

      // A roving tabindex is the one legitimate reason to combine these: the owning
      // tablist or menu moves focus with the arrow keys and keeps exactly one child at 0.
      const role = roleOf(el);
      if (role !== null && MANAGED_ROLES.has(role)) continue;
      if (inCompositeWidget(el)) continue;

      out.push(
        ctx.report(
          payload(
            {
              ruleId: 'A11Y-KBD-008',
              wcag: ['2.1.1'],
              level: 'A',
              severity: 'warning',
              start: el.openStart,
              end: el.openEnd,
              message:
                `<${el.tag}> handles ${click.name} but tabindex="-1" takes it out of the tab ` +
                'order, and it is not inside a composite widget that would move focus to it.',
              impact:
                'Tab never reaches this element, so unless some other code focuses it ' +
                'deliberately, the action it performs can only be triggered with a pointer. ' +
                'A keyboard or switch user has no route to it at all.',
            },
            {
              // Flipping -1 to 0 is wrong whenever the element is focused programmatically —
              // a dialog container, a backdrop, a cell in a grid — and we cannot see the code
              // that would do that from here.
              safety: 'manual',
              edits: [],
              description: 'Decide whether this element is meant to be reachable by Tab.',
              advisory:
                'If a person is meant to activate this, change tabindex to "0", give it a ' +
                'role, and add a key handler — or use a <button>. If it is focused from ' +
                'script (a dialog container, a backdrop that closes on click) leave the -1 ' +
                'and make sure the same action has a keyboard route, such as Escape.',
            },
          ),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-009 — anchor with no href
// ---------------------------------------------------------------------------

const anchorWithoutHref: Rule = {
  id: 'A11Y-KBD-009',
  title: 'Anchor with no href',
  wcag: ['2.1.1', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'An <a> without href is neither focusable nor announced as a link.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      // Lowercase `a` only: `<Link>` is a component whose props we cannot inspect.
      if (el.tagLower !== 'a' || el.tag !== el.tagLower) continue;
      if (hasAttrLoose(el, 'href')) continue;
      if (hasAttrLoose(el, 'role') || hasAttrLoose(el, 'tabindex')) continue;

      const click = clickAttrOf(el);
      const text = textOf(el);
      // `<a id="section-3"></a>` is a legacy scroll target, not a control. Only an anchor
      // that a user is expected to act on — one with a handler or visible text — is a bug.
      if (click === undefined && text === '') continue;

      out.push(
        ctx.report(
          payload(
            {
              ruleId: 'A11Y-KBD-009',
              wcag: ['2.1.1', '4.1.2'],
              level: 'A',
              severity: 'error',
              start: el.openStart,
              end: el.openEnd,
              message:
                click === undefined
                  ? '<a> has no href, so the browser treats it as a placeholder: it is not in ' +
                    'the tab order and is not announced as a link.'
                  : `<a> has a ${click.name} handler but no href, so it is not focusable and ` +
                    'not announced as a link — the styling is the only thing that says it is one.',
              impact:
                'Tab skips the element entirely and a screen reader lists it nowhere among the ' +
                'page’s links, so a user navigating by link — one of the fastest ways to move ' +
                'through a page — is never offered it. Only a mouse click works.',
            },
            {
              // We cannot know the destination. A marker href makes the element focusable and
              // announced while remaining obviously unfinished, so CI catches it before ship.
              safety: 'manual',
              edits: [
                insertAttrs(
                  ctx,
                  el,
                  `href="#${TODO_MARKER}"`,
                  `add placeholder href="#${TODO_MARKER}"`,
                ),
              ],
              description:
                `Insert a placeholder href containing ${TODO_MARKER} so the anchor is focusable ` +
                'and the missing destination fails CI. Replace it with the real URL — or, if ' +
                'this element runs an action on the current page rather than navigating, make ' +
                'it a <button type="button"> instead.',
            },
          ),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-KBD-010 — inline style that removes the focus indicator
// ---------------------------------------------------------------------------

interface Declaration {
  readonly prop: string;
  readonly value: string;
  /** Absolute offsets covering the declaration, including any leading whitespace. */
  readonly start: number;
  readonly end: number;
}

/**
 * Split a style attribute into declarations, keeping absolute offsets.
 *
 * Hand-written rather than regex-driven: splitting on ';' is linear and cannot
 * backtrack, and the only thing it mis-parses is a semicolon inside url(), which
 * produces a fragment with no colon that is then discarded.
 */
function parseDeclarations(text: string, base: number): Declaration[] {
  const out: Declaration[] = [];
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf(';', i);
    if (j < 0) j = text.length;
    const chunk = text.slice(i, j);
    const colon = chunk.indexOf(':');
    if (colon > 0) {
      out.push({
        prop: chunk.slice(0, colon).trim().toLowerCase(),
        value: chunk.slice(colon + 1).trim().toLowerCase(),
        start: base + i,
        end: base + j,
      });
    }
    i = j + 1;
  }
  return out;
}

const ZERO_LENGTH = /^0(?:px|em|rem|pt|%)?$/;

/** True when the declaration makes the outline invisible. */
function suppressesOutline(d: Declaration): boolean {
  const tokens = d.value.replace('!important', '').trim().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return false;
  if (d.prop === 'outline') {
    return tokens.every((t) => t === 'none' || ZERO_LENGTH.test(t));
  }
  if (d.prop === 'outline-style') return tokens[0] === 'none';
  if (d.prop === 'outline-width') return ZERO_LENGTH.test(tokens[0] ?? '');
  return false;
}

const outlineNoneInline: Rule = {
  id: 'A11Y-KBD-010',
  title: 'Inline style removes the focus indicator',
  wcag: ['2.4.7'],
  level: 'AA',
  severity: 'error',
  summary: 'outline: none in a style attribute, with nothing drawn in its place.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      const attr = getAttr(el, 'style');
      if (attr === undefined || attr.value === null) continue;
      // Only a plain quoted string can be edited safely. `style={{...}}` and `:style` are
      // objects and expressions; the CSS pass owns stylesheets, so neither belongs here.
      if (!isStaticValue(attr) || (attr.quote !== '"' && attr.quote !== "'")) continue;

      // An outline on something that can never be focused is decorative, not an indicator.
      const focusable = isFocusable(el) || clickAttrOf(el) !== undefined;
      if (!focusable) continue;

      const contentStart = attr.valueStart + 1;
      const contentEnd = attr.valueEnd - 1;
      if (contentEnd <= contentStart) continue;
      const decls = parseDeclarations(ctx.source.slice(contentStart, contentEnd), contentStart);

      const offender = decls.find(suppressesOutline);
      if (offender === undefined) continue;
      // A box-shadow in the same block is the usual hand-rolled replacement ring. It is a
      // weak substitute inline — nothing here is conditional on focus — but the author has
      // clearly drawn something, so this is not the blind `outline: none` we are after.
      if (decls.some((d) => d.prop === 'box-shadow' && d.value !== 'none')) continue;

      // Work out how much text to delete: the declaration plus its separator, so no
      // stray semicolon is left behind at either end of the attribute.
      let start = offender.start;
      let end = offender.end;
      if (end < contentEnd && ctx.source[end] === ';') end += 1;
      while (end < contentEnd) {
        const ch = ctx.source[end];
        if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') break;
        end += 1;
      }
      if (end >= contentEnd) {
        while (start > contentStart) {
          const ch = ctx.source[start - 1];
          if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== ';') break;
          start -= 1;
        }
      }
      const remainder = (
        ctx.source.slice(contentStart, start) + ctx.source.slice(end, contentEnd)
      ).trim();

      const edit: Edit =
        remainder === '' || remainder === ';'
          ? // Nothing else in the attribute: take the whole thing rather than leave style="".
            removeAttr(ctx, attr, 'remove style attribute')
          : { start, end, replacement: '', label: `remove ${offender.prop}: ${offender.value}` };

      out.push(
        ctx.report(
          payload(
            {
              ruleId: 'A11Y-KBD-010',
              wcag: ['2.4.7'],
              level: 'AA',
              severity: 'error',
              start: offender.start,
              end: offender.end,
              message:
                `The inline style on <${el.tag}> sets ${offender.prop}: ${offender.value}, ` +
                'which removes the focus ring the browser draws. An inline style cannot ' +
                'contain a :focus or :focus-visible rule, so nothing here can put one back.',
              impact:
                'A sighted keyboard user loses all trace of where focus is. Tabbing becomes ' +
                'guesswork across the whole page, because the only feedback the browser gives ' +
                'about the current element has been switched off.',
            },
            {
              safety: 'review',
              edits: [edit],
              description:
                'Delete the outline suppression so the browser focus ring comes back. If the ' +
                'default ring does not suit the design, replace it in a stylesheet with a ' +
                ':focus-visible rule that draws a visible indicator, rather than removing it ' +
                'here where no focus state can be expressed.',
            },
          ),
        ),
      );
    }
    return out;
  },
};

export const RULES: readonly Rule[] = [
  positiveTabindex,
  clickHandlerNotFocusable,
  roleWithoutKeyHandler,
  ariaHiddenFocusable,
  presentationOnInteractive,
  accesskeyPresent,
  autofocusPresent,
  negativeTabindexWithClick,
  anchorWithoutHref,
  outlineNoneInline,
];
