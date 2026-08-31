/**
 * Forms, labels and controls.
 *
 * This family is where source-level fixing earns its keep. A DOM checker can tell you
 * "this input has no accessible name"; it cannot tell you that the fix is three
 * characters — `for` — added to the `<label>` sitting right next to it in the file.
 * That one patch, A11Y-FORM-001's label-wiring path, is the highest-value edit the tool
 * emits, and it is only possible because we still have the source layout in hand.
 *
 * It is nevertheless a `review` fix, not an `automatic` one. Source adjacency is strong
 * evidence that a label belongs to a control, but it is not proof: a `<label>` used as a
 * group heading sits in exactly the same place as a real field label. Wiring the wrong
 * one gives the control a confidently *wrong* accessible name, which is the same failure
 * as invented alt text — the user is misled and every downstream checker reports the
 * page as fixed. So the patch is offered in the diff and never written unasked.
 *
 * Everything else here is deliberately timid. A control's name is human text; we refuse
 * to invent it. Where we do patch, the answer has to be derivable from what is already
 * written in the file (an existing id, an existing placeholder, an input type).
 */

import type { Attr, Element } from '../parse/markup.js';
import type { Edit, Fix, Rule, RuleContext, Violation } from '../types.js';
import { getAttr, hasAttr, textOf } from '../parse/markup.js';
import { TODO_MARKER } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * True for a real HTML element rather than a JSX/Vue/Svelte component.
 *
 * `el.tagLower` alone is a trap: `<Input />` lowercases to "input" but is somebody's
 * component with props we cannot see, so reasoning about HTML semantics on it produces
 * confident nonsense.
 */
function isHtmlTag(el: Element): boolean {
  // Requiring a lowercase start also skips legacy uppercase HTML (`<INPUT>`). That is
  // the intended trade: silently doing nothing to a rare shouted tag is cheaper than
  // rewriting somebody's <Input> component as if it were a form field.
  return /^[a-z]/.test(el.tag);
}

/** True when the tag name is capitalised, i.e. a component in every dialect we read. */
function isComponent(el: Element): boolean {
  return /^[A-Z]/.test(el.tag);
}

/**
 * Find an attribute, tolerating the binding syntaxes that mean the same attribute.
 * Vue writes `:id="x"` and `v-bind:id="x"`; both set the id, so a presence check that
 * only looks for `id` would report a control that is in fact fine.
 */
function findAttr(el: Element, name: string): Attr | undefined {
  const direct = getAttr(el, name);
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  return el.attrs.find((a) => a.nameLower === ':' + lower || a.nameLower === 'v-bind:' + lower);
}

/** The attribute's literal text, or null when it is absent or an expression. */
function literalAttr(el: Element, name: string): string | null {
  const a = findAttr(el, name);
  if (a === undefined) return null;
  if (a.dynamic || a.quote === '{') return null;
  return a.value;
}

/**
 * True when the attribute would supply a value at runtime.
 * An expression counts as present: `aria-label={t('close')}` names the control even
 * though we cannot read the string.
 */
function attrHasContent(el: Element, name: string): boolean {
  const a = findAttr(el, name);
  if (a === undefined) return false;
  if (a.dynamic || a.quote === '{') return true;
  return (a.value ?? '').trim().length > 0;
}

/**
 * True when this element is hidden from assistive technology.
 *
 * `attrHasContent(el, 'aria-hidden')` is the wrong test and was previously used here:
 * `aria-hidden="false"` is a non-empty value, so an element explicitly marked *visible*
 * to assistive technology was being skipped by every naming rule. Only "false" un-hides;
 * an expression could be either, so we stay quiet on it.
 */
function isAriaHidden(el: Element): boolean {
  const a = findAttr(el, 'aria-hidden');
  if (a === undefined) return false;
  if (a.dynamic || a.quote === '{') return true;
  return (a.value ?? '').trim().toLowerCase() !== 'false';
}

/** Hidden from assistive technology, or from rendering altogether. */
function isHiddenFromAT(el: Element): boolean {
  return isAriaHidden(el) || hasAttr(el, 'hidden');
}

/**
 * True when the opening tag contains a spread / v-bind object.
 *
 * The parser skips `{...props}` because it carries no attribute name, so an element
 * written `<input {...field} />` looks bare to us while actually receiving an
 * `aria-label`. Every naming rule below bails out on this rather than guess.
 */
function hasSpreadAttrs(source: string, el: Element): boolean {
  const open = source.slice(el.openStart, el.openEnd);
  return /\{\s*\.\.\./.test(open) || /\bv-bind\s*=/.test(open);
}

/**
 * True when the element's own text content is produced by an expression.
 * `<button>{label}</button>` has text at runtime; `textOf` strips expressions, so
 * without this guard every interpolated button would be reported as icon-only.
 */
function hasDynamicText(el: Element): boolean {
  // Strip child tags first so a component's own props (`<Icon name={x} />`) are not
  // mistaken for interpolated text belonging to the parent.
  return /\{/.test(el.innerSource.replace(/<[^>]*>/g, ' '));
}

/** Opening tag was never terminated; we must not compute insertion points into it. */
function isUnterminated(source: string, el: Element): boolean {
  return el.openEnd < 2 || source[el.openEnd - 1] !== '>';
}

/**
 * Offset at which a new attribute can be inserted into the opening tag.
 *
 * HTML void elements report `selfClosing === true` with no slash before `>`, so the
 * character has to be checked rather than the flag trusted.
 */
function attrInsertPoint(source: string, el: Element): number | null {
  if (isUnterminated(source, el)) return null;
  const slash = el.selfClosing && source[el.openEnd - 2] === '/';
  return el.openEnd - (slash ? 2 : 1);
}

function insertAttrEdit(
  source: string,
  el: Element,
  text: string,
  label: string,
): Edit | null {
  const at = attrInsertPoint(source, el);
  if (at === null) return null;
  // Two rules may legitimately insert different attributes at this same offset (an
  // aria-label and an autocomplete, say). Both replacements must therefore carry their
  // own separator on the side that is not already spaced, or the two run together into
  // one nonsense attribute name when both are applied.
  const prev = source[at - 1];
  const spacedBefore = prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r';
  return { start: at, end: at, replacement: spacedBefore ? text + ' ' : ' ' + text, label };
}

/** Elements a `<label for>` is allowed to point at. */
const LABELABLE = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress']);

/** Input types that are not labelable form fields in the sense these rules care about. */
const NON_FIELD_INPUT_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

function isFormControl(el: Element): boolean {
  if (!isHtmlTag(el)) return false;
  const t = el.tagLower;
  return t === 'input' || t === 'select' || t === 'textarea';
}

/** A control that a nearby `<label>` might be intended for. Buttons are labelable too. */
function isLabelTarget(el: Element): boolean {
  return isFormControl(el) || (isHtmlTag(el) && el.tagLower === 'button');
}

/** Literal `type` of an input, lowercased. "text" when absent, null when dynamic. */
function inputType(el: Element): string | null {
  const a = findAttr(el, 'type');
  if (a === undefined) return 'text';
  if (a.dynamic || a.quote === '{') return null;
  return (a.value ?? '').trim().toLowerCase() || 'text';
}

function descendants(el: Element, out: Element[] = []): Element[] {
  for (const child of el.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function ancestors(el: Element): Element[] {
  const out: Element[] = [];
  let cur = el.parent;
  while (cur !== null) {
    out.push(cur);
    cur = cur.parent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document index
// ---------------------------------------------------------------------------

interface FormIndex {
  /** Literal `for` / `htmlFor` value -> the labels using it. */
  readonly labelFor: Map<string, Element[]>;
  /** Literal `id` value -> the elements carrying it. */
  readonly ids: Map<string, Element[]>;
  /** Some element's id is an expression, so id/for matching cannot be trusted. */
  readonly dynamicIds: boolean;
  /** Some label's `for` is an expression. */
  readonly dynamicLabelFor: boolean;
  /** The document contains components whose rendered ids/props we cannot see. */
  readonly components: boolean;
  /** Write `htmlFor` rather than `for` when patching a label. */
  readonly jsx: boolean;
}

/** `for` in HTML/Vue/Svelte, `htmlFor` in JSX. */
function labelForAttr(el: Element): Attr | undefined {
  return findAttr(el, 'for') ?? findAttr(el, 'htmlFor');
}

function buildIndex(ctx: RuleContext): FormIndex {
  const labelFor = new Map<string, Element[]>();
  const ids = new Map<string, Element[]>();
  let dynamicIds = false;
  let dynamicLabelFor = false;
  let components = false;
  let jsxAttrSeen = false;

  for (const el of ctx.markup.elements) {
    if (isComponent(el)) components = true;

    const idAttr = findAttr(el, 'id');
    if (idAttr !== undefined) {
      if (idAttr.dynamic || idAttr.quote === '{') dynamicIds = true;
      else {
        const v = (idAttr.value ?? '').trim();
        if (v !== '') {
          const bucket = ids.get(v);
          if (bucket === undefined) ids.set(v, [el]);
          else bucket.push(el);
        }
      }
    }

    if (el.attrs.some((a) => a.nameLower === 'classname' || a.nameLower === 'htmlfor')) {
      jsxAttrSeen = true;
    }

    if (el.tagLower === 'label') {
      const f = labelForAttr(el);
      if (f !== undefined) {
        if (f.dynamic || f.quote === '{') dynamicLabelFor = true;
        else {
          const v = (f.value ?? '').trim();
          if (v !== '') {
            const bucket = labelFor.get(v);
            if (bucket === undefined) labelFor.set(v, [el]);
            else bucket.push(el);
          }
        }
      }
    }
  }

  // The extension is authoritative where we have one we recognise. Sniffing for
  // `className` is only a tie-breaker for unknown extensions: an .html page that merely
  // *mentions* className (a code sample, a JS string) would otherwise have us write
  // `htmlFor` into real HTML, where it is an inert attribute that labels nothing.
  const file = ctx.file;
  const jsx = /\.[jt]sx$/i.test(file)
    ? true
    : /\.(?:html?|vue|svelte|astro)$/i.test(file)
      ? false
      : jsxAttrSeen;

  return { labelFor, ids, dynamicIds, dynamicLabelFor, components, jsx };
}

// ---------------------------------------------------------------------------
// Accessible-name reasoning for a control
// ---------------------------------------------------------------------------

type NameSource =
  | { kind: 'none' }
  | { kind: 'aria' }
  | { kind: 'title' }
  | { kind: 'label-for' }
  | { kind: 'wrapping-label' }
  | { kind: 'wrapping-label-empty'; label: Element }
  | { kind: 'unknown' };

/**
 * Where this control's accessible name comes from, if anywhere.
 * `unknown` means we found a reason not to judge (a component ancestor, an expression),
 * and the caller must stay quiet.
 */
function nameSourceOf(ctx: RuleContext, el: Element, index: FormIndex): NameSource {
  if (attrHasContent(el, 'aria-label') || attrHasContent(el, 'aria-labelledby')) return { kind: 'aria' };
  if (attrHasContent(el, 'title')) return { kind: 'title' };

  for (const a of ancestors(el)) {
    // A `<Label>` component wrapping the control is as good as a `<label>` for our
    // purposes: we cannot see what it renders, so we must not accuse it.
    if (a.tagLower === 'label') {
      if (isComponent(a)) return { kind: 'unknown' };
      if (textOf(a) !== '' || hasDynamicText(a)) return { kind: 'wrapping-label' };
      return { kind: 'wrapping-label-empty', label: a };
    }
    // Field wrappers usually pass a label down; `<Field label="Email">` names the input.
    if (isComponent(a) && (attrHasContent(a, 'label') || attrHasContent(a, 'aria-label'))) {
      return { kind: 'unknown' };
    }
  }

  const idAttr = findAttr(el, 'id');
  if (idAttr !== undefined) {
    if (idAttr.dynamic || idAttr.quote === '{') {
      // A dynamic id can only be resolved together with a dynamic `for`. If the file
      // has one, the pair probably matches and we cannot prove otherwise.
      return index.dynamicLabelFor || index.components ? { kind: 'unknown' } : { kind: 'none' };
    }
    const id = (idAttr.value ?? '').trim();
    if (id !== '' && index.labelFor.has(id)) return { kind: 'label-for' };
  }

  if (hasSpreadAttrs(ctx.source, el)) return { kind: 'unknown' };
  return { kind: 'none' };
}

/**
 * How many sibling elements may sit between a control and the label we will claim is
 * "adjacent" to it. Two covers the layouts that actually occur (`<label><br><input>`,
 * `<label><span class=hint><input>`); more than that is not adjacency any more.
 */
const MAX_LABEL_GAP = 3;

/**
 * A `<label>` that has no `for`, sits beside this control, and unambiguously belongs
 * to it. "Unambiguously" is the whole point: a label that two controls could equally
 * claim must produce no patch at all.
 */
function adjacentOrphanLabel(ctx: RuleContext, el: Element): Element | null {
  const siblings = el.parent !== null ? el.parent.children : [...ctx.markup.roots];
  const idx = siblings.indexOf(el);
  if (idx < 0) return null;

  const orphan = (s: Element): boolean =>
    isHtmlTag(s) &&
    s.tagLower === 'label' &&
    labelForAttr(s) === undefined &&
    !hasSpreadAttrs(ctx.source, s) &&
    s.end > s.openEnd &&
    s.innerSource.trim() !== '' &&
    // A control inside the label is already named by it (implicit association), so the
    // label is not orphaned. A *component* inside it may well render such a control —
    // `<label><Input /></label>` — and we cannot see, so it is not ours to re-point.
    !descendants(s).some((d) => isLabelTarget(d) || isComponent(d));

  let cand: Element | null = null;
  // Scan outward, stopping at the first other control: anything past it is that
  // control's business, not ours. The gap is bounded because "adjacent" has to mean
  // something: a <label> eight elements up the sibling list is a section heading far
  // more often than it is this field's name.
  for (let i = idx - 1; i >= 0 && idx - i <= MAX_LABEL_GAP; i--) {
    const s = siblings[i];
    if (s === undefined) continue;
    if (isLabelTarget(s)) break;
    if (orphan(s)) { cand = s; break; }
  }
  if (cand === null) {
    for (let i = idx + 1; i < siblings.length && i - idx <= MAX_LABEL_GAP; i++) {
      const s = siblings[i];
      if (s === undefined) continue;
      if (isLabelTarget(s)) break;
      if (orphan(s)) { cand = s; break; }
    }
  }
  if (cand === null) return null;

  // Now look from the label back out: it must be closer to us than to any other
  // control. A tie (`<input><label>x</label><input>`) is genuinely ambiguous.
  const ci = siblings.indexOf(cand);
  let back = -1;
  let fwd = -1;
  for (let i = ci - 1; i >= 0; i--) {
    const s = siblings[i];
    if (s !== undefined && isLabelTarget(s)) { back = i; break; }
  }
  for (let i = ci + 1; i < siblings.length; i++) {
    const s = siblings[i];
    if (s !== undefined && isLabelTarget(s)) { fwd = i; break; }
  }
  const dBack = back < 0 ? Infinity : ci - back;
  const dFwd = fwd < 0 ? Infinity : fwd - ci;
  if (dBack === dFwd) return null;
  const winner = dFwd < dBack ? fwd : back;
  return siblings[winner] === el ? cand : null;
}

/** ids we are willing to write into a `for` attribute without escaping gymnastics. */
const SAFE_ID = /^[A-Za-z][-A-Za-z0-9_:.]*$/;

function describeControl(el: Element): string {
  if (el.tagLower === 'input') {
    const t = inputType(el);
    return t === null ? '<input>' : `<input type="${t}">`;
  }
  return `<${el.tagLower}>`;
}

/** A manual fix whose only job is to plant a marker a human must replace. */
function markerFix(edit: Edit | null, description: string, advisory: string): Fix {
  if (edit === null) return { safety: 'manual', edits: [], description, advisory };
  return { safety: 'manual', edits: [edit], description };
}

function markerValue(hint: string): string {
  return `"${TODO_MARKER} ${hint}"`;
}

// ---------------------------------------------------------------------------
// A11Y-FORM-001 — control with no accessible name
// ---------------------------------------------------------------------------

const controlHasNoName: Rule = {
  id: 'A11Y-FORM-001',
  title: 'Form control has no accessible name',
  wcag: ['1.3.1', '3.3.2', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'input, select and textarea must be named by a label, aria-label or title.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    const index = buildIndex(ctx);

    for (const el of ctx.markup.elements) {
      if (!isFormControl(el)) continue;
      if (isHiddenFromAT(el)) continue;

      if (el.tagLower === 'input') {
        const t = inputType(el);
        if (t === null) continue; // dynamic type: could be hidden, could be anything
        if (NON_FIELD_INPUT_TYPES.has(t)) continue;
      }

      // Handled by A11Y-FORM-002, which has the placeholder text to work with.
      if ((literalAttr(el, 'placeholder') ?? '').trim() !== '') continue;

      const source = nameSourceOf(ctx, el, index);
      if (source.kind !== 'none' && source.kind !== 'wrapping-label-empty') continue;

      const what = describeControl(el);

      if (source.kind === 'wrapping-label-empty') {
        out.push(
          ctx.report({
            ruleId: controlHasNoName.id,
            wcag: controlHasNoName.wcag,
            level: 'A',
            severity: 'error',
            start: el.openStart,
            end: el.openEnd,
            message: `${what} is wrapped in a <label> that contains no text.`,
            impact:
              'The label element exists but is empty, so the control is announced as just ' +
              '"edit text" with nothing to say what belongs in it. Anyone not looking at the ' +
              'surrounding page has no way to know what they are filling in.',
            fix: {
              safety: 'manual',
              edits: [],
              description: 'Put the visible field name inside the existing <label>.',
              advisory:
                'The wrapper is already correct; it just needs words. Write the name a sighted ' +
                'user would read next to this field between the <label> tags.',
            },
          }),
        );
        continue;
      }

      // The valuable case: a label is sitting right there and only needs wiring up.
      const idAttr = findAttr(el, 'id');
      const id = idAttr !== undefined && !idAttr.dynamic && idAttr.quote !== '{'
        ? (idAttr.value ?? '').trim()
        : '';
      const orphanLabel = id !== '' && SAFE_ID.test(id) && (index.ids.get(id)?.length ?? 0) === 1
        ? adjacentOrphanLabel(ctx, el)
        : null;

      if (orphanLabel !== null) {
        const attrName = index.jsx ? 'htmlFor' : 'for';
        const edit = insertAttrEdit(
          ctx.source,
          orphanLabel,
          `${attrName}="${id}"`,
          `add ${attrName}="${id}" to the adjacent <label>`,
        );
        if (edit !== null) {
          out.push(
            ctx.report({
              ruleId: controlHasNoName.id,
              wcag: controlHasNoName.wcag,
              level: 'A',
              severity: 'error',
              start: el.openStart,
              end: el.openEnd,
              message:
                `${what} has id="${id}" and an adjacent <label>, but nothing connects them.`,
              impact:
                'The label is visible on screen but is not programmatically associated with the ' +
                'field, so a screen reader announces the control unnamed and clicking the label ' +
                'does not focus it. The text is right there; only the link is missing.',
              fix: {
                // Deliberately not `automatic`. Adjacency is evidence, not proof: a
                // <label> used as a group heading occupies the same position as a field
                // label, and wiring that one up names the control wrongly rather than
                // leaving it unnamed. Confirm the label text belongs to this field.
                safety: 'review',
                edits: [edit],
                description:
                  `Adds ${attrName}="${id}" to the neighbouring <label> so it names this control. ` +
                  'Check that the label text is this field’s name and not a heading for the group.',
              },
            }),
          );
          continue;
        }
      }

      const insertPoint = insertAttrEdit(
        ctx.source,
        el,
        `aria-label=${markerValue('name this field')}`,
        'insert a placeholder aria-label for a human to replace',
      );
      out.push(
        ctx.report({
          ruleId: controlHasNoName.id,
          wcag: controlHasNoName.wcag,
          level: 'A',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message: `${what} has no label, aria-label, aria-labelledby or title.`,
          impact:
            'A screen reader announces this only as "edit text" or "combo box" with no name, so ' +
            'the person has to guess what to type from context they cannot hear. Voice-control ' +
            'users cannot address the field at all, because it has no name to speak.',
          fix: markerFix(
            insertPoint,
            `Inserts an aria-label containing ${TODO_MARKER} that a human must replace; ` +
              'a visible <label for> is the better fix.',
            'Add a visible <label for="…"> naming this field. We will not invent the name: ' +
              'only someone who knows the form knows what this field collects.',
          ),
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-002 — placeholder used as the label
// ---------------------------------------------------------------------------

const placeholderAsLabel: Rule = {
  id: 'A11Y-FORM-002',
  title: 'Placeholder used as the only label',
  wcag: ['1.3.1', '3.3.2', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'A placeholder is not a label: it disappears as soon as the user types.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    const index = buildIndex(ctx);

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el)) continue;
      if (el.tagLower !== 'input' && el.tagLower !== 'textarea') continue;
      if (isHiddenFromAT(el)) continue;
      if (el.tagLower === 'input') {
        const t = inputType(el);
        if (t === null || NON_FIELD_INPUT_TYPES.has(t)) continue;
      }

      const placeholder = (literalAttr(el, 'placeholder') ?? '').trim();
      if (placeholder === '') continue;

      const source = nameSourceOf(ctx, el, index);
      if (source.kind !== 'none') continue;

      // Deliberately not a copy of the placeholder. Placeholders carry example values as
      // often as names — "e.g. jane@example.com", "dd/mm/yyyy", "Search…" — and announcing
      // one as the field's name is worse than announcing nothing, because it reads as
      // deliberate and it silences every checker downstream, including this one. The
      // placeholder is quoted in the message instead, where a human can weigh it. This is
      // also the promise the README makes: nothing but an empty value or a marker is ever
      // written into a name position.
      const edit = insertAttrEdit(
        ctx.source,
        el,
        `aria-label=${markerValue('name this field')}`,
        'insert a placeholder aria-label for a human to replace',
      );

      const fix: Fix = markerFix(
        edit,
        `Inserts an aria-label containing ${TODO_MARKER} that a human must replace; a visible ` +
          '<label for> that stays on screen is the better fix.',
        'Add a visible <label for="…"> naming this field. The placeholder is not a name: ' +
          'copying it in would announce an example value as the field’s name.',
      );

      out.push(
        ctx.report({
          ruleId: placeholderAsLabel.id,
          wcag: placeholderAsLabel.wcag,
          level: 'A',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message: `<${el.tagLower}> is labelled only by placeholder="${placeholder}".`,
          impact:
            'The placeholder vanishes the moment the field has content, so a person who is ' +
            'interrupted mid-form, or who returns to check an answer, sees an unlabelled box. ' +
            'Placeholder text is also rendered in low-contrast grey by default, and some screen ' +
            'readers skip it entirely.',
          fix,
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-003 — checkbox / radio with no name attribute
// ---------------------------------------------------------------------------

const checkableWithoutName: Rule = {
  id: 'A11Y-FORM-003',
  title: 'Checkbox or radio has no name attribute',
  wcag: ['1.3.1'],
  level: 'A',
  severity: 'warning',
  summary: 'Radios without a shared name are not a group, and neither type submits a value.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el) || el.tagLower !== 'input') continue;
      const t = inputType(el);
      if (t !== 'checkbox' && t !== 'radio') continue;
      if (findAttr(el, 'name') !== undefined) continue;
      if (hasSpreadAttrs(ctx.source, el)) continue;
      // React's controlled inputs manage state without `name`; only flag radios there,
      // where the missing name breaks grouping regardless of how state is handled.
      if (t === 'checkbox' && findAttr(el, 'checked') !== undefined) continue;

      const isRadio = t === 'radio';
      out.push(
        ctx.report({
          ruleId: checkableWithoutName.id,
          wcag: checkableWithoutName.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `<input type="${t}"> has no name attribute.`,
          impact: isRadio
            ? 'Without a shared name these radios are not a group: assistive technology announces ' +
              'each one as an isolated control instead of "1 of 4", arrow keys do not move between ' +
              'them, and more than one can be selected at once.'
            : 'The checkbox has no name, so its state is never submitted with the form and it is ' +
              'not associated with any other checkboxes in the same question.',
          fix: {
            safety: 'manual',
            edits: [],
            description: isRadio
              ? 'Give every radio in this question the same name attribute.'
              : 'Give the checkbox a name attribute.',
            advisory: isRadio
              ? 'Set name="…" to the same value on every radio that answers this question. We ' +
                'cannot pick the value: it is the field name your form handler expects.'
              : 'Set name="…" to the field name your form handler expects.',
          },
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-004 — icon-only button
// ---------------------------------------------------------------------------

/** Props that commonly carry an icon's identity and hint at the intended label. */
const HINT_ATTRS = ['name', 'icon', 'iconname', 'glyph', 'symbol', 'data-icon', 'data-testid'];

/**
 * Does anything inside this button contribute an accessible name?
 * Name computation walks the subtree, so a child's aria-label or an `<svg><title>` is
 * a real name and must not be reported.
 */
function subtreeNames(el: Element): boolean {
  for (const d of descendants(el)) {
    if (attrHasContent(d, 'aria-label') || attrHasContent(d, 'aria-labelledby')) return true;
    if (attrHasContent(d, 'title')) return true;
    if (d.tagLower === 'title' && (textOf(d) !== '' || hasDynamicText(d))) return true;
    if (d.tagLower === 'img' && attrHasContent(d, 'alt')) return true;
  }
  return false;
}

function subtreeHint(el: Element): string | null {
  for (const d of descendants(el)) {
    for (const name of HINT_ATTRS) {
      const v = literalAttr(d, name);
      if (v !== null && v.trim() !== '' && v.length <= 40) {
        return `<${d.tag} ${name}="${v.trim()}">`;
      }
    }
  }
  return null;
}

const buttonHasNoName: Rule = {
  id: 'A11Y-FORM-004',
  title: 'Button has no accessible name',
  wcag: ['4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'An icon-only button needs an aria-label; the glyph is not a name.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el)) continue;

      const isButton = el.tagLower === 'button';
      const isButtonInput = el.tagLower === 'input' && inputType(el) === 'button';
      if (!isButton && !isButtonInput) continue;
      if (isHiddenFromAT(el)) continue;
      if (hasSpreadAttrs(ctx.source, el)) continue;
      if (attrHasContent(el, 'aria-label') || attrHasContent(el, 'aria-labelledby')) continue;
      if (attrHasContent(el, 'title')) continue;

      if (isButtonInput) {
        // `<input type="button">` takes its name from `value`; submit/reset have a UA
        // default and are excluded by the type check above.
        if (attrHasContent(el, 'value')) continue;
        out.push(
          ctx.report({
            ruleId: buttonHasNoName.id,
            wcag: buttonHasNoName.wcag,
            level: 'A',
            severity: 'error',
            start: el.openStart,
            end: el.openEnd,
            message: '<input type="button"> has no value, aria-label or title.',
            impact:
              'The button renders as an empty box and is announced as just "button", so nobody ' +
              'relying on the announcement can tell what pressing it will do.',
            fix: markerFix(
              insertAttrEdit(
                ctx.source,
                el,
                `value=${markerValue('button text')}`,
                'insert a placeholder value for a human to replace',
              ),
              `Inserts value="${TODO_MARKER} …" for a human to replace with the button's text.`,
              'Set value="…" to the words that describe the action.',
            ),
          }),
        );
        continue;
      }

      if (el.end === el.openEnd) continue; // unclosed <button>: content unknown
      if (textOf(el) !== '') continue;
      if (hasDynamicText(el)) continue; // <button>{label}</button>
      if (subtreeNames(el)) continue;

      // `<button><img …></button>` is A11Y-FORM-005's job; it points at the image so we
      // do not file two complaints, or two patches, about one missing name.
      const onlyChild = el.children.length === 1 ? el.children[0] : undefined;
      if (onlyChild !== undefined && isHtmlTag(onlyChild) && onlyChild.tagLower === 'img') continue;

      const hint = subtreeHint(el);
      const description =
        `Inserts an aria-label containing ${TODO_MARKER} for a human to replace` +
        (hint === null ? '.' : ` — the child ${hint} suggests what the label should say.`);

      out.push(
        ctx.report({
          ruleId: buttonHasNoName.id,
          wcag: buttonHasNoName.wcag,
          level: 'A',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message:
            hint === null
              ? '<button> has no text content, aria-label or title.'
              : `<button> has no text content, aria-label or title; its only content is ${hint}.`,
          impact:
            'A screen reader announces this as "button" and nothing else, so its purpose is ' +
            'carried entirely by a glyph that is never spoken. Voice-control users cannot say ' +
            '"click …" because there is no name to say, and the button is unreachable for them.',
          fix: markerFix(
            insertAttrEdit(
              ctx.source,
              el,
              `aria-label=${markerValue('name this button')}`,
              'insert a placeholder aria-label for a human to replace',
            ),
            description,
            'Add aria-label="…" describing the action, not the icon: "Close dialog", not "X".',
          ),
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-005 — link or button whose only content is an image
// ---------------------------------------------------------------------------

const imageOnlyControl: Rule = {
  id: 'A11Y-FORM-005',
  title: 'Link or button named only by an image with no alt text',
  wcag: ['1.1.1', '2.4.4', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'When an image is the whole link, its alt text is the link name.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el)) continue;
      if (el.tagLower !== 'a' && el.tagLower !== 'button') continue;
      if (el.end === el.openEnd) continue;
      if (isAriaHidden(el)) continue;
      if (attrHasContent(el, 'aria-label') || attrHasContent(el, 'aria-labelledby')) continue;
      if (attrHasContent(el, 'title')) continue;
      // `<a {...props}><img …></a>` may be receiving an aria-label we cannot see.
      if (hasSpreadAttrs(ctx.source, el)) continue;
      if (el.children.length !== 1) continue;

      const img = el.children[0];
      if (img === undefined || !isHtmlTag(img) || img.tagLower !== 'img') continue;
      // Likewise `<img {...rest} />` may already be carrying the alt text.
      if (hasSpreadAttrs(ctx.source, img)) continue;
      if (textOf(el) !== '' || hasDynamicText(el)) continue;

      const alt = findAttr(img, 'alt');
      if (alt !== undefined && (alt.dynamic || alt.quote === '{')) continue; // expression
      if (alt !== undefined && (alt.value ?? '').trim() !== '') continue;

      const isLink = el.tagLower === 'a';
      const missing = alt === undefined;

      // Reported at the image, with no edit. The images family owns patches to `alt`;
      // duplicating one here would put two rules on the same source range.
      out.push(
        ctx.report({
          ruleId: imageOnlyControl.id,
          wcag: imageOnlyControl.wcag,
          level: 'A',
          severity: 'error',
          start: img.openStart,
          end: img.openEnd,
          message: missing
            ? `This <img> is the entire content of a <${el.tagLower}> and has no alt attribute.`
            : `This <img> is the entire content of a <${el.tagLower}> and has alt="".`,
          impact: isLink
            ? 'The image is the link, so its alt text is the link name. With none, a screen ' +
              'reader falls back to reading the image URL aloud — "slash assets slash img underscore ' +
              '4471 dot png" — or announces "link" with no destination at all.'
            : 'The image is the button, so its alt text is the button name. With none, the button ' +
              'is announced as "button" with no purpose, or as the image file name.',
          fix: {
            safety: 'manual',
            edits: [],
            description: isLink
              ? 'Give this image alt text describing where the link goes.'
              : 'Give this image alt text describing what the button does.',
            advisory: isLink
              ? 'Write the destination, not the picture: alt="Home", not alt="logo". If the link ' +
                'already has visible text elsewhere, use alt="" and name the link instead.'
              : 'Write the action, not the picture: alt="Delete item", not alt="trash icon".',
          },
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-006 — identity input with no autocomplete (WCAG 1.3.5)
// ---------------------------------------------------------------------------

/**
 * Input type -> autocomplete token, for the types that are unambiguous on their own.
 */
const TYPE_TOKENS: Readonly<Record<string, string>> = {
  email: 'email',
  tel: 'tel',
  url: 'url',
};

/**
 * Normalised name/id -> autocomplete token.
 *
 * Every entry here is one a human would write the same way; anything that could
 * plausibly mean two different tokens (a bare "password", a bare "number") is left out
 * on purpose, because a wrong autocomplete token makes a browser offer the wrong saved
 * value, which is worse for the user than offering nothing.
 */
const NAME_TOKENS: Readonly<Record<string, string>> = {
  email: 'email', emailaddress: 'email', useremail: 'email', mail: 'email',
  tel: 'tel', telephone: 'tel', phone: 'tel', phonenumber: 'tel', telnumber: 'tel',
  mobile: 'tel', mobilenumber: 'tel', cellphone: 'tel',
  name: 'name', fullname: 'name', yourname: 'name',
  firstname: 'given-name', fname: 'given-name', givenname: 'given-name', forename: 'given-name',
  lastname: 'family-name', lname: 'family-name', surname: 'family-name', familyname: 'family-name',
  middlename: 'additional-name',
  nickname: 'nickname',
  username: 'username', userid: 'username', loginname: 'username', login: 'username',
  organization: 'organization', organisation: 'organization', company: 'organization',
  companyname: 'organization',
  address: 'address-line1', address1: 'address-line1', addressline1: 'address-line1',
  streetaddress: 'address-line1', street: 'address-line1',
  address2: 'address-line2', addressline2: 'address-line2',
  city: 'address-level2', town: 'address-level2', locality: 'address-level2',
  state: 'address-level1', province: 'address-level1', region: 'address-level1',
  county: 'address-level1',
  zip: 'postal-code', zipcode: 'postal-code', postcode: 'postal-code',
  postalcode: 'postal-code', postal: 'postal-code',
  country: 'country-name', countryname: 'country-name',
  ccnumber: 'cc-number', cardnumber: 'cc-number', creditcard: 'cc-number',
  creditcardnumber: 'cc-number', cardno: 'cc-number',
  ccname: 'cc-name', cardname: 'cc-name', nameoncard: 'cc-name', cardholder: 'cc-name',
  cardholdername: 'cc-name',
  ccexp: 'cc-exp', expiry: 'cc-exp', expirydate: 'cc-exp', expiration: 'cc-exp',
  expirationdate: 'cc-exp', ccexpiry: 'cc-exp',
  ccexpmonth: 'cc-exp-month', expmonth: 'cc-exp-month', expirymonth: 'cc-exp-month',
  ccexpyear: 'cc-exp-year', expyear: 'cc-exp-year', expiryyear: 'cc-exp-year',
  cvc: 'cc-csc', cvv: 'cc-csc', csc: 'cc-csc', cccsc: 'cc-csc', securitycode: 'cc-csc',
  cardcode: 'cc-csc',
  birthday: 'bday', birthdate: 'bday', dob: 'bday', dateofbirth: 'bday',
  currentpassword: 'current-password', oldpassword: 'current-password',
  existingpassword: 'current-password',
  newpassword: 'new-password', confirmpassword: 'new-password',
  passwordconfirm: 'new-password', passwordconfirmation: 'new-password',
  repeatpassword: 'new-password', password1: 'new-password', password2: 'new-password',
  website: 'url', homepage: 'url', url: 'url',
};

/** Types that never collect information about the user. */
const NON_IDENTITY_TYPES = new Set([
  'hidden', 'submit', 'reset', 'button', 'image', 'checkbox', 'radio', 'file',
  'range', 'color', 'search',
]);

function normaliseKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The best token we can justify from what is written on this element, or null. */
function inferAutocomplete(el: Element): string | null {
  const type = inputType(el);
  if (type === null) return null;
  // `Object.hasOwn`, not a truthiness test: these tables are plain object literals, so
  // they answer for every name on Object.prototype too. `<input type="constructor">`
  // looked up the Object constructor, passed the `!== undefined` check, and offered to
  // write autocomplete="function Object() { [native code] }" into somebody's source;
  // `<input name="constructor">` reached `token.endsWith` on a function and threw.
  const byType = Object.hasOwn(TYPE_TOKENS, type) ? TYPE_TOKENS[type] : undefined;
  if (byType !== undefined) return byType;

  for (const attr of ['name', 'id']) {
    const raw = literalAttr(el, attr);
    if (raw === null) continue;
    // Strip the framework noise around the real field name: `user[email]`,
    // `billing.postal_code`. Nothing else is stripped: a name like `field-3-zip`
    // normalises to `field3zip`, matches no token, and is left alone on purpose —
    // guessing that the trailing word is the field's meaning is how a browser ends up
    // offering a postcode for a field that wanted something else.
    const parts = raw.split(/[[\].]+/).filter((p) => p !== '');
    const last = parts.length > 0 ? parts[parts.length - 1] : raw;
    const key = normaliseKey(last ?? raw);
    const token = Object.hasOwn(NAME_TOKENS, key) ? NAME_TOKENS[key] : undefined;
    if (token !== undefined) {
      // A password field only earns a token when the name says which password it is.
      if (type === 'password' && !token.endsWith('password')) continue;
      if (type !== 'password' && token.endsWith('password')) continue;
      return token;
    }
  }
  return null;
}

const missingAutocomplete: Rule = {
  id: 'A11Y-FORM-006',
  title: 'Identity input has no autocomplete token',
  wcag: ['1.3.5'],
  level: 'AA',
  severity: 'warning',
  summary: 'Fields collecting the user’s own details need an autocomplete token.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el) || el.tagLower !== 'input') continue;
      if (findAttr(el, 'autocomplete') !== undefined) continue;
      if (hasSpreadAttrs(ctx.source, el)) continue;
      if (isHiddenFromAT(el)) continue;

      const type = inputType(el);
      if (type === null || NON_IDENTITY_TYPES.has(type)) continue;

      const token = inferAutocomplete(el);

      if (token === null) {
        // Only nag about a password field, where the omission is both certain and
        // consequential; every other unrecognised field is left alone to keep the
        // rule quiet enough to be worth reading.
        if (type !== 'password') continue;
        out.push(
          ctx.report({
            ruleId: missingAutocomplete.id,
            wcag: missingAutocomplete.wcag,
            level: 'AA',
            severity: 'warning',
            start: el.openStart,
            end: el.openEnd,
            message: '<input type="password"> has no autocomplete token.',
            impact:
              'Password managers and browser autofill cannot identify the field, so a person who ' +
              'cannot reliably type a long password — through a motor impairment, dyslexia or ' +
              'memory difficulty — has to enter it by hand every time.',
            fix: {
              safety: 'manual',
              edits: [],
              description: 'Choose between autocomplete="current-password" and "new-password".',
              advisory:
                'Use autocomplete="current-password" on a sign-in form and "new-password" on ' +
                'registration or password-change forms. The field name here does not say which ' +
                'this is, so we will not guess: the wrong token makes the browser offer the ' +
                'wrong saved password.',
            },
          }),
        );
        continue;
      }

      const edit = insertAttrEdit(
        ctx.source,
        el,
        `autocomplete="${token}"`,
        `add autocomplete="${token}"`,
      );
      const fix: Fix =
        edit === null
          ? {
              safety: 'manual',
              edits: [],
              description: `Add autocomplete="${token}".`,
              advisory: `Add autocomplete="${token}" to this field.`,
            }
          : {
              safety: 'review',
              edits: [edit],
              description:
                `Adds autocomplete="${token}", inferred from the input's type and name. Check ` +
                'that this field really collects the user’s own details and not a third ' +
                'party’s — 1.3.5 only applies to the former.',
            };

      out.push(
        ctx.report({
          ruleId: missingAutocomplete.id,
          wcag: missingAutocomplete.wcag,
          level: 'AA',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `Identity field has no autocomplete attribute; "${token}" fits its type and name.`,
          impact:
            'Without the token the browser cannot fill the field from stored details, so someone ' +
            'with a motor or cognitive impairment must retype personal information they have ' +
            'already given many times, and tools that substitute familiar icons or wording for ' +
            'each field have nothing to key off.',
          fix,
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-007 — fieldset without legend
// ---------------------------------------------------------------------------

const fieldsetWithoutLegend: Rule = {
  id: 'A11Y-FORM-007',
  title: 'Fieldset grouping choices has no legend',
  wcag: ['1.3.1', '3.3.2'],
  level: 'A',
  severity: 'warning',
  summary: 'A group of radios or checkboxes needs a legend naming the question.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el) || el.tagLower !== 'fieldset') continue;
      if (el.end === el.openEnd) continue; // unclosed: contents unknown
      if (attrHasContent(el, 'aria-label') || attrHasContent(el, 'aria-labelledby')) continue;
      if (hasSpreadAttrs(ctx.source, el)) continue;

      const kids = descendants(el);
      // A component child could render the legend, so say nothing.
      if (kids.some(isComponent)) continue;
      if (el.children.some((c) => c.tagLower === 'legend')) continue;

      const checkables = kids.filter(
        (d) => isHtmlTag(d) && d.tagLower === 'input' && (inputType(d) === 'radio' || inputType(d) === 'checkbox'),
      );
      if (checkables.length < 2) continue;

      const kind = inputType(checkables[0] as Element) === 'radio' ? 'radio buttons' : 'checkboxes';

      out.push(
        ctx.report({
          ruleId: fieldsetWithoutLegend.id,
          wcag: fieldsetWithoutLegend.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `<fieldset> groups ${checkables.length} ${kind} but has no <legend>.`,
          impact:
            'Each option is announced with its own label but nothing says what the question is, ' +
            'so a screen-reader user hears "Standard, radio button, 1 of 3" without ever learning ' +
            'that the choice is about delivery speed.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Add a <legend> as the first child of this <fieldset>.',
            advisory:
              'Insert `<legend>…</legend>` immediately after the opening <fieldset> tag, ' +
              'containing the question these options answer. We do not write it in for you ' +
              'because the wording is the question itself, and only you know it.',
          },
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-008 — required field indicated only by an asterisk
// ---------------------------------------------------------------------------

/**
 * Text that explains what an asterisk means, in the languages this rule can read.
 *
 * Each alternative uses only bounded quantifiers over character classes, so there is no
 * nested repetition for a pathological input to backtrack over. The `=` form is spelled
 * separately because `\b` after `=` can never match a following space, which silently
 * broke the commonest legend of all: "* = required".
 *
 * The Russian half is here because the rule was accusing Russian forms of leaving an
 * asterisk unexplained while the page said «* — обязательные поля» directly above it.
 * The end-of-word guards are lookaheads rather than `\b`, which is defined over ASCII
 * word characters and therefore never matches after a Cyrillic letter.
 */
const ASTERISK_LEGEND = new RegExp(
  [
    String.raw`\*\s{0,4}(?:indicates|denotes|means|marks|is)(?![\p{L}])`,
    String.raw`\*\s{0,4}=`,
    String.raw`required\s{1,4}fields?(?![\p{L}])`,
    // «обязательные поля», «обязательно для заполнения», «обязательные к заполнению».
    String.raw`обязательн\p{L}{0,6}\s{0,4}(?:для\s{1,4}заполнени\p{L}{1,2}|к\s{1,4}заполнению|пол[яе])`,
    // «поля, отмеченные *, обязательны» — the same sentence with the words the other way.
    String.raw`пол[яе]\p{L}{0,3}[^.!?]{0,48}обязательн`,
    // «Звёздочкой отмечены…», in both of the two spellings Russian writes it in.
    String.raw`зв[еёе]здочк\p{L}{0,3}`,
  ].join('|'),
  'iu',
);

const asteriskOnlyRequired: Rule = {
  id: 'A11Y-FORM-008',
  title: 'Required field marked only by an asterisk',
  wcag: ['3.3.2'],
  level: 'A',
  severity: 'info',
  summary: 'An unexplained * is the only sign the field is required.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    const index = buildIndex(ctx);

    // Deliberately narrow: we only speak up when an asterisk is doing the work and
    // nothing on the page explains it. A form that says "* indicates a required field"
    // is fine and must stay silent.
    // Only text a person can actually read counts as an explanation, so this asks the
    // markup and not the file. Testing the raw source meant a CSS attribute selector —
    // `[class*="cell"]` inside one inline <style> — matched the `* =` form and switched
    // the rule off for the entire document; true on five of the ninety-two pages in the
    // audit corpus, and invisible because the symptom is silence.
    const visible = ctx.markup.roots.map((r) => textOf(r)).join(' ');
    if (ASTERISK_LEGEND.test(visible)) return out;

    for (const el of ctx.markup.elements) {
      if (!isFormControl(el)) continue;
      if (findAttr(el, 'aria-required') !== undefined) continue;
      if (hasSpreadAttrs(ctx.source, el)) continue;

      // Find the label that names this control, and check it for a lone asterisk.
      let label: Element | null = null;
      for (const a of ancestors(el)) {
        if (a.tagLower === 'label' && isHtmlTag(a)) { label = a; break; }
      }
      if (label === null) {
        const id = (literalAttr(el, 'id') ?? '').trim();
        const bucket = id === '' ? undefined : index.labelFor.get(id);
        label = bucket !== undefined && bucket.length === 1 ? (bucket[0] as Element) : null;
      }
      if (label === null) continue;
      const labelText = textOf(label);
      if (!labelText.includes('*')) continue;

      const nativeRequired = findAttr(el, 'required') !== undefined;

      if (nativeRequired) {
        out.push(
          ctx.report({
            ruleId: asteriskOnlyRequired.id,
            wcag: asteriskOnlyRequired.wcag,
            level: 'A',
            severity: 'info',
            start: el.openStart,
            end: el.openEnd,
            message: `Label "${labelText}" marks this required field with an asterisk that nothing explains.`,
            impact:
              'The asterisk is read out as "star" or skipped as punctuation, and nowhere on the ' +
              'page says what it means. Sighted users infer the convention from the visual ' +
              'pattern; someone hearing the form one field at a time cannot.',
            fix: {
              safety: 'manual',
              edits: [],
              description:
                'Explain the asterisk once near the top of the form, e.g. "* indicates a required field".',
              advisory:
                'The required attribute already tells assistive technology this field is ' +
                'mandatory, so no attribute needs adding here — the gap is the unexplained ' +
                'asterisk. Add a sentence at the start of the form that defines it.',
            },
          }),
        );
        continue;
      }

      const edit = insertAttrEdit(ctx.source, el, 'aria-required="true"', 'add aria-required="true"');
      if (edit === null) continue;
      out.push(
        ctx.report({
          ruleId: asteriskOnlyRequired.id,
          wcag: asteriskOnlyRequired.wcag,
          level: 'A',
          severity: 'info',
          start: el.openStart,
          end: el.openEnd,
          message: `Label "${labelText}" carries an asterisk but the control has neither required nor aria-required.`,
          impact:
            'The asterisk is the only indication that this field must be filled in, and it is ' +
            'purely visual: the control is announced as optional, so the person only discovers ' +
            'the requirement when the form rejects their submission.',
          fix: {
            safety: 'review',
            edits: [edit],
            description:
              'Adds aria-required="true" so the control is announced as required. Confirm the ' +
              'asterisk really means required here, and explain it once near the top of the form.',
          },
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-009 — form with no submit control
// ---------------------------------------------------------------------------

const formWithoutSubmit: Rule = {
  id: 'A11Y-FORM-009',
  title: 'Form has no submit control',
  wcag: [],
  level: 'A',
  severity: 'warning',
  summary: 'A form that can only be submitted by pressing Enter is not operable for everyone.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el) || el.tagLower !== 'form') continue;
      if (el.end === el.openEnd) continue; // unclosed: contents unknown

      const kids = descendants(el);
      // Any component in the subtree could be the submit button (`<Button type="submit">`),
      // and we cannot see what it renders.
      if (kids.some(isComponent)) continue;

      const hasSubmit = kids.some((d) => {
        if (!isHtmlTag(d)) return false;
        if (d.tagLower === 'button') {
          const t = literalAttr(d, 'type');
          if (findAttr(d, 'type') !== undefined && t === null) return true; // dynamic type
          const type = (t ?? 'submit').trim().toLowerCase();
          return type === 'submit' || type === '';
        }
        if (d.tagLower === 'input') {
          const type = inputType(d);
          return type === null || type === 'submit' || type === 'image';
        }
        return false;
      });
      if (hasSubmit) continue;

      // A form with no fields at all is a wrapper, not a form to submit.
      //
      // `isFormControl` tests the tag name only; every other rule that matters pairs it
      // with NON_FIELD_INPUT_TYPES, and this one did not. nlr.ru's `<form id="searchForm">`
      // holds four hidden inputs and nothing else — a parameter carrier the visible
      // sibling form submits by script — and got "contains fields but no submit button"
      // under an impact paragraph about the Enter key, textareas, switch access and
      // on-screen keyboards, none of which can apply to a form with nothing in it. The
      // discontinuity is the tell: an empty <form> was correctly skipped, and adding one
      // hidden input flipped it to a warning.
      const visibleField = (d: Element): boolean =>
        isFormControl(d) &&
        !(d.tagLower === 'input' && NON_FIELD_INPUT_TYPES.has(inputType(d) ?? ''));
      if (!kids.some(visibleField)) continue;

      out.push(
        ctx.report({
          ruleId: formWithoutSubmit.id,
          wcag: formWithoutSubmit.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: '<form> contains fields but no submit button.',
          impact:
            'The only way to submit is the implicit Enter-key behaviour, which does not exist ' +
            'when the form has more than one field, is unavailable from a textarea, and is ' +
            'invisible to anyone using switch access, voice control or an on-screen keyboard.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Add a <button type="submit"> to this form.',
            advisory:
              'Add `<button type="submit">…</button>` with wording that names the action ' +
              '("Create account", not "Submit"). We leave the text to you.',
          },
        }),
      );
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// A11Y-FORM-010 — label points at an id that does not exist
// ---------------------------------------------------------------------------

const brokenLabelFor: Rule = {
  id: 'A11Y-FORM-010',
  title: 'Label points at an id that does not exist',
  wcag: ['1.3.1', '4.1.2'],
  level: 'A',
  severity: 'error',
  summary: 'A label’s for attribute names an element that is not in the document.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx) {
    const out: Violation[] = [];
    const index = buildIndex(ctx);

    // Any component, or any id built from an expression, could be the missing target.
    // Without that certainty this rule would fire on perfectly correct JSX, so it
    // simply declines to run.
    if (index.components || index.dynamicIds) return out;

    // "No element in this file has that id" is only evidence of a bug when this file is
    // plausibly the whole picture. A fragment holding labels but no controls at all —
    // a partial, a slot, a legend column — has its targets somewhere else by design, and
    // reporting every one of them as broken would make the rule unusable on templates.
    if (!ctx.markup.elements.some(isLabelTarget)) return out;

    for (const el of ctx.markup.elements) {
      if (!isHtmlTag(el) || el.tagLower !== 'label') continue;
      const forAttr = labelForAttr(el);
      if (forAttr === undefined) continue;
      if (forAttr.dynamic || forAttr.quote === '{') continue;
      const target = (forAttr.value ?? '').trim();
      if (target === '') continue;

      const matches = index.ids.get(target);

      if (matches === undefined) {
        out.push(
          ctx.report({
            ruleId: brokenLabelFor.id,
            wcag: brokenLabelFor.wcag,
            level: 'A',
            severity: 'error',
            start: forAttr.nameStart,
            end: forAttr.valueEnd,
            message: `<label> has for="${target}" but no element in this file has id="${target}".`,
            impact:
              'The association silently fails: the control this label describes is announced with ' +
              'no name, and clicking the label does not move focus into it. Because the label is ' +
              'visible and looks correct, the bug survives every review that does not use a ' +
              'screen reader.',
            fix: {
              safety: 'manual',
              edits: [],
              description: `Point for="${target}" at the control it labels, or give that control the id.`,
              advisory:
                `Either add id="${target}" to the control this label belongs to, or correct the ` +
                'for value to the id it already has. We cannot pick: both are one-character ' +
                'changes and only you know which one was intended.',
            },
          }),
        );
        continue;
      }

      const first = matches[0];
      if (first === undefined) continue;
      if (matches.length === 1 && !LABELABLE.has(first.tagLower)) {
        out.push(
          ctx.report({
            ruleId: brokenLabelFor.id,
            wcag: brokenLabelFor.wcag,
            level: 'A',
            severity: 'error',
            start: forAttr.nameStart,
            end: forAttr.valueEnd,
            message: `<label for="${target}"> points at a <${first.tagLower}>, which cannot be labelled.`,
            impact:
              'Only form controls accept a label. Pointing at a wrapper element makes the ' +
              'association a no-op, so the real control inside is still announced without a name ' +
              'and clicking the label does nothing.',
            fix: {
              safety: 'manual',
              edits: [],
              description: `Move id="${target}" onto the control itself, or point for at the control's id.`,
              advisory:
                `The id="${target}" is on a <${first.tagLower}>. Put it on the <input>, <select> ` +
                'or <textarea> inside instead, or change the for value to that control’s id.',
            },
          }),
        );
      }
    }

    return out;
  },
};

export const RULES: readonly Rule[] = [
  controlHasNoName,
  placeholderAsLabel,
  checkableWithoutName,
  buttonHasNoName,
  imageOnlyControl,
  missingAutocomplete,
  fieldsetWithoutLegend,
  asteriskOnlyRequired,
  formWithoutSubmit,
  brokenLabelFor,
];
