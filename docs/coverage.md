# What A11yFix checks, and what it cannot

> This file is generated from the rule set by `npm run docs`. It cannot drift from
> the code, which is the point: a coverage claim that is written by hand eventually
> describes a tool that no longer exists.

## The short version

A11yFix ships **70 rules** touching **17 of the 55**
WCAG 2.2 A and AA success criteria listed here.

**No criterion is fully covered by automation, and this table says "partial" for every
one it touches on purpose.** A rule can prove that an `<img>` has no `alt` attribute. It
cannot prove that an `alt` which *is* present describes the image. The first is a
machine question; the second is not, and no amount of engineering changes that.

Passing every check in this tool is not conformance. It means the machine-checkable
part is clean and the human review can start from a smaller pile.

The table below lists what a rule **can** cite, which is not always what a given
finding cites. A handful of rules answer the question per element rather than once: a
duplicate `id` breaks 1.3.1 and 4.1.2 when an `aria-labelledby` or a `<label for>`
resolves to it, and is only a bug when nothing does; a `<video>` with no captions is
1.2.2 while a `<audio>` is 1.2.1. The criterion printed next to a finding is the one
that applies to it.

## Criteria this tool checks

| SC | Level | Name | Rules |
|---|---|---|---|
| 1.1.1 | A | Non-text Content | A11Y-IMG-001, A11Y-IMG-002, A11Y-IMG-003, A11Y-IMG-004, A11Y-IMG-005, A11Y-IMG-006, A11Y-IMG-009, A11Y-IMG-010, A11Y-FORM-005, A11Y-ARIA-010 |
| 1.2.1 | A | Audio-only and Video-only (Prerecorded) | A11Y-IMG-008 |
| 1.2.2 | A | Captions (Prerecorded) | A11Y-IMG-008 |
| 1.3.1 | A | Info and Relationships | A11Y-FORM-001, A11Y-FORM-002, A11Y-FORM-003, A11Y-FORM-007, A11Y-FORM-010, A11Y-DOC-004, A11Y-DOC-006, A11Y-DOC-007, A11Y-DOC-008, A11Y-DOC-009, A11Y-DOC-010, A11Y-DOC-013, A11Y-ARIA-007, A11Y-ARIA-009 |
| 1.3.5 | AA | Identify Input Purpose | A11Y-FORM-006 |
| 1.4.1 | A | Use of Color | A11Y-COLOR-003 |
| 1.4.3 | AA | Contrast (Minimum) | A11Y-COLOR-001 |
| 1.4.11 | AA | Non-text Contrast | A11Y-COLOR-002 |
| 2.1.1 | A | Keyboard | A11Y-KBD-002, A11Y-KBD-003, A11Y-KBD-008, A11Y-KBD-009 |
| 2.4.1 | A | Bypass Blocks | A11Y-DOC-014, A11Y-DOC-015 |
| 2.4.2 | A | Page Titled | A11Y-DOC-003 |
| 2.4.3 | A | Focus Order | A11Y-KBD-001 |
| 2.4.4 | A | Link Purpose (In Context) | A11Y-IMG-005, A11Y-FORM-005, A11Y-LINK-001, A11Y-LINK-002, A11Y-LINK-003, A11Y-LINK-006 |
| 2.4.7 | AA | Focus Visible | A11Y-KBD-010 |
| 3.1.1 | A | Language of Page | A11Y-DOC-001, A11Y-DOC-002 |
| 3.3.2 | A | Labels or Instructions | A11Y-FORM-001, A11Y-FORM-002, A11Y-FORM-007, A11Y-FORM-008 |
| 4.1.2 | A | Name, Role, Value | A11Y-IMG-004, A11Y-FORM-001, A11Y-FORM-002, A11Y-FORM-004, A11Y-FORM-005, A11Y-FORM-010, A11Y-DOC-006, A11Y-DOC-014, A11Y-KBD-002, A11Y-KBD-004, A11Y-KBD-005, A11Y-KBD-009, A11Y-ARIA-001, A11Y-ARIA-002, A11Y-ARIA-004, A11Y-ARIA-005, A11Y-ARIA-006, A11Y-ARIA-008, A11Y-ARIA-009, A11Y-ARIA-011, A11Y-ARIA-012, A11Y-LINK-001, A11Y-LINK-007 |

## Criteria this tool does not check

These need a person, a browser, or both. Nothing in A11yFix will ever report on them,
so a clean run tells you nothing about this list.

| SC | Level | Name |
|---|---|---|
| 1.2.3 | A | Audio Description or Media Alternative (Prerecorded) |
| 1.2.4 | AA | Captions (Live) |
| 1.2.5 | AA | Audio Description (Prerecorded) |
| 1.3.2 | A | Meaningful Sequence |
| 1.3.3 | A | Sensory Characteristics |
| 1.3.4 | AA | Orientation |
| 1.4.2 | A | Audio Control |
| 1.4.4 | AA | Resize Text |
| 1.4.5 | AA | Images of Text |
| 1.4.10 | AA | Reflow |
| 1.4.12 | AA | Text Spacing |
| 1.4.13 | AA | Content on Hover or Focus |
| 2.1.2 | A | No Keyboard Trap |
| 2.1.4 | A | Character Key Shortcuts |
| 2.2.1 | A | Timing Adjustable |
| 2.2.2 | A | Pause, Stop, Hide |
| 2.3.1 | A | Three Flashes or Below Threshold |
| 2.4.5 | AA | Multiple Ways |
| 2.4.6 | AA | Headings and Labels |
| 2.4.11 | AA | Focus Not Obscured (Minimum) |
| 2.5.1 | A | Pointer Gestures |
| 2.5.2 | A | Pointer Cancellation |
| 2.5.3 | A | Label in Name |
| 2.5.4 | A | Motion Actuation |
| 2.5.7 | AA | Dragging Movements |
| 2.5.8 | AA | Target Size (Minimum) |
| 3.1.2 | AA | Language of Parts |
| 3.2.1 | A | On Focus |
| 3.2.2 | A | On Input |
| 3.2.3 | AA | Consistent Navigation |
| 3.2.4 | AA | Consistent Identification |
| 3.2.6 | A | Consistent Help |
| 3.3.1 | A | Error Identification |
| 3.3.3 | AA | Error Suggestion |
| 3.3.4 | AA | Error Prevention (Legal, Financial, Data) |
| 3.3.7 | A | Redundant Entry |
| 3.3.8 | AA | Accessible Authentication (Minimum) |
| 4.1.3 | AA | Status Messages |

## Why "partial" everywhere

Three limits apply to every rule here.

**Source is not a page.** A component file is a fragment. Whether two `id` attributes
actually collide, whether a heading level really skips, and what colour an element ends
up rendering all depend on how the pieces are composed at runtime. A11yFix reports what
is provable from the file and stays quiet otherwise.

**Static analysis cannot evaluate the cascade.** Colours behind a runtime expression, a
media query, a container query or a theme switch are not resolved. Values written as
literals, Tailwind utilities, CSS custom properties or `@theme` tokens are.

**Meaning is not machine-readable.** Alternative text, link purpose, heading wording and
language are all judgements about intent. The tool marks them and refuses to guess.

## The full rule list

| Rule | WCAG | Level | Title |
|---|---|---|---|
| `A11Y-ARIA-001` | 4.1.2 | A | role must be a defined ARIA role |
| `A11Y-ARIA-002` | 4.1.2 | A | aria-* attribute must be a defined ARIA attribute |
| `A11Y-ARIA-003` | — | A | role duplicates the element’s native semantics |
| `A11Y-ARIA-004` | 4.1.2 | A | aria-labelledby / aria-describedby must reference an existing id |
| `A11Y-ARIA-005` | 4.1.2 | A | aria-label is dead code next to aria-labelledby |
| `A11Y-ARIA-006` | 4.1.2 | A | aria-label on an element whose role cannot carry a name |
| `A11Y-ARIA-007` | 1.3.1 | A | role requires an ancestor with a specific role |
| `A11Y-ARIA-008` | 4.1.2 | A | boolean aria-* attribute must be "true" or "false" |
| `A11Y-ARIA-009` | 1.3.1, 4.1.2 | A | aria-hidden must not hide the page or its heading |
| `A11Y-ARIA-010` | 1.1.1 | A | role="img" requires an accessible name |
| `A11Y-ARIA-011` | 4.1.2 | A | aria-* attribute is not supported by the element’s role |
| `A11Y-ARIA-012` | 4.1.2 | A | aria-* value must match the attribute’s value type |
| `A11Y-COLOR-001` | 1.4.3 | AA | Text contrast below the required ratio |
| `A11Y-COLOR-002` | 1.4.11 | AA | Interactive element border below 3:1 |
| `A11Y-COLOR-003` | 1.4.1 | A | Link distinguished from body text by colour alone |
| `A11Y-DOC-001` | 3.1.1 | A | Document has no language |
| `A11Y-DOC-002` | 3.1.1 | A | Document language is not a valid language tag |
| `A11Y-DOC-003` | 2.4.2 | A | Document has no title |
| `A11Y-DOC-004` | 1.3.1 | A | Heading level skipped |
| `A11Y-DOC-005` | — | A | Page does not have exactly one h1 |
| `A11Y-DOC-006` | 1.3.1, 4.1.2 | A | Duplicate id |
| `A11Y-DOC-007` | 1.3.1 | A | List contains a child that is not a list item |
| `A11Y-DOC-008` | 1.3.1 | A | List item outside a list |
| `A11Y-DOC-009` | 1.3.1 | A | Table has no header cells |
| `A11Y-DOC-010` | 1.3.1 | A | Header cell has no scope |
| `A11Y-DOC-011` | — | A | Data table has no caption |
| `A11Y-DOC-012` | — | A | Page has no main landmark |
| `A11Y-DOC-013` | 1.3.1 | A | Page has more than one main landmark |
| `A11Y-DOC-014` | 2.4.1, 4.1.2 | A | Frame has no title |
| `A11Y-DOC-015` | 2.4.1 | A | No way to skip the navigation |
| `A11Y-DOC-016` | — | A | Accessibility overlay on the page |
| `A11Y-FORM-001` | 1.3.1, 3.3.2, 4.1.2 | A | Form control has no accessible name |
| `A11Y-FORM-002` | 1.3.1, 3.3.2, 4.1.2 | A | Placeholder used as the only label |
| `A11Y-FORM-003` | 1.3.1 | A | Checkbox or radio has no name attribute |
| `A11Y-FORM-004` | 4.1.2 | A | Button has no accessible name |
| `A11Y-FORM-005` | 1.1.1, 2.4.4, 4.1.2 | A | Link or button named only by an image with no alt text |
| `A11Y-FORM-006` | 1.3.5 | AA | Identity input has no autocomplete token |
| `A11Y-FORM-007` | 1.3.1, 3.3.2 | A | Fieldset grouping choices has no legend |
| `A11Y-FORM-008` | 3.3.2 | A | Required field marked only by an asterisk |
| `A11Y-FORM-009` | — | A | Form has no submit control |
| `A11Y-FORM-010` | 1.3.1, 4.1.2 | A | Label points at an id that does not exist |
| `A11Y-IMG-001` | 1.1.1 | A | Image has no alt attribute |
| `A11Y-IMG-002` | 1.1.1 | A | Alt text is a file name or a placeholder |
| `A11Y-IMG-003` | 1.1.1 | A | Alt text repeats the role of the element |
| `A11Y-IMG-004` | 1.1.1, 4.1.2 | A | Image button has no alt attribute |
| `A11Y-IMG-005` | 1.1.1, 2.4.4 | A | Image map area has no alt attribute |
| `A11Y-IMG-006` | 1.1.1 | A | Inline SVG has no accessible name |
| `A11Y-IMG-008` | 1.2.1, 1.2.2 | A | Media element has no captions track |
| `A11Y-IMG-009` | 1.1.1 | A | Embedded object has no text alternative |
| `A11Y-IMG-010` | 1.1.1 | A | Decorative image also carries a label |
| `A11Y-KBD-001` | 2.4.3 | A | Positive tabindex |
| `A11Y-KBD-002` | 2.1.1, 4.1.2 | A | Click handler on a non-focusable element |
| `A11Y-KBD-003` | 2.1.1 | A | Custom control with no keyboard activation |
| `A11Y-KBD-004` | 4.1.2 | A | aria-hidden on a focusable element |
| `A11Y-KBD-005` | 4.1.2 | A | Presentational role on an interactive element |
| `A11Y-KBD-006` | — | A | accesskey attribute |
| `A11Y-KBD-007` | — | A | autofocus attribute |
| `A11Y-KBD-008` | 2.1.1 | A | Click handler on an element removed from the tab order |
| `A11Y-KBD-009` | 2.1.1, 4.1.2 | A | Anchor with no href |
| `A11Y-KBD-010` | 2.4.7 | AA | Inline style removes the focus indicator |
| `A11Y-LINK-001` | 2.4.4, 4.1.2 | A | Link has no discernible text |
| `A11Y-LINK-002` | 2.4.4, 2.4.9 | A | Generic link text |
| `A11Y-LINK-003` | 2.4.4 | A | Link text is a bare URL |
| `A11Y-LINK-004` | — | A | target="_blank" without rel="noopener" |
| `A11Y-LINK-005` | 3.2.5 | AAA | New window opened without warning |
| `A11Y-LINK-006` | 2.4.4, 2.4.9 | A | Identical link text, different destinations |
| `A11Y-LINK-007` | 4.1.2 | A | Anchor used as a button |
| `A11Y-LINK-008` | — | A | Fragment link with no target |
| `A11Y-LINK-009` | — | A | Adjacent duplicate links |
| `A11Y-TODO-001` | — | A | An A11yFix placeholder is still in the source |
