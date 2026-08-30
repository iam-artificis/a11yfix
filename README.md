# A11yFix

**Accessibility tools tell you what is broken. This one writes the patch.**

```
npx a11yfix src --diff
```

```diff
--- a/src/Card.tsx
+++ b/src/Card.tsx
@@ -1,9 +1,9 @@
 export function Card({ title }: { title: string }) {
   return (
     <div className="bg-white p-6">
-      <h2 className="text-gray-400 text-2xl font-bold">{title}</h2>
-      <p className="text-gray-400">Supporting copy that is hard to read.</p>
-      <span className="text-emerald-500">Status: active</span>
+      <h2 className="text-gray-500 text-2xl font-bold">{title}</h2>
+      <p className="text-gray-500">Supporting copy that is hard to read.</p>
+      <span className="text-emerald-700">Status: active</span>
       <p className="text-gray-700">This passes and must be left alone.</p>
     </div>
   );
```

---

## Why this exists

Every accessibility checker — axe, Lighthouse, WAVE, Pa11y — inspects the **rendered
DOM**. It tells you that a node on a page fails a contrast ratio. Then a human works out
which component produced that node, finds the file, finds the colour, decides what to
change it to, and checks the change did not break the design.

That translation step is most of the work, and no tool does it.

A11yFix reads your **source**, keeps byte-exact offsets for every tag and attribute, and
emits a patch. It runs in about a second on a few thousand files, needs no browser, no
network, no API key, and no runtime dependencies at all.

## What it actually fixes

Contrast repair is the centrepiece, because it is the most common failure on the web and
the only common one with an arithmetic answer rather than a judgement call.

Given a foreground and a background, A11yFix finds the **smallest perceptual change**
that reaches the required ratio. It works in OKLCH: hue is held fixed, lightness moves by
the minimum needed, and chroma is only reduced if the result would fall outside sRGB.

It also picks the right side of the pair to move. White text on a mid-tone button gets
fixed by darkening the button, not by turning the label charcoal — a naive fixer gets
this wrong about half the time.

In a Tailwind codebase it swaps the shade rather than injecting a hex literal, walking
the ramp until it finds a step that **actually clears the threshold**, and quotes the
ratio that step really reaches. It composites `bg-black/10` against what is behind it,
resolves CSS custom properties and Tailwind v4 `@theme` tokens, and stops at a gradient
or a background image instead of pretending the colour underneath is what you see.

Beyond contrast, 68 rules cover images and media alternatives, form labelling, document
structure, keyboard operability, ARIA correctness, and link semantics — each anchored to
the WCAG success criterion it implements.

## What it will never do

**It does not invent alt text.** It cannot see the image. A plausible-sounding wrong
description is worse than a missing one: it lies to a screen-reader user *and* makes
every downstream checker report the page as fixed. Same for link text, button labels, and
`lang`. Those are reported with a marker that fails CI until a person writes the words.

**It does not claim conformance.** Automated testing reaches roughly a third of WCAG's
success criteria. A clean run means the machine-checkable subset passes. Keyboard flows,
focus order, meaningful alternative text and actual screen-reader behaviour still need a
human. Every run prints this. See [docs/coverage.md](docs/coverage.md) for the exact list
of what is and is not covered.

**It does not patch what it cannot prove.** If a colour resolves through a runtime
expression, if the element sits over a background image, or if a fix would need a change
large enough to alter the design, A11yFix says so and leaves the file alone.

## Fix safety

Every fix carries a safety level, and nothing is written without you asking.

| Level | Meaning | Applied by |
|---|---|---|
| `automatic` | One provably correct answer, independent of context | `--fix` |
| `review` | Correct in the common case, worth a glance | `--fix --include-review` |
| `manual` | Needs knowledge the tool does not have | never — advice only |

## Usage

```bash
npx a11yfix .                          # report, change nothing
npx a11yfix src --diff                 # preview the patch
npx a11yfix src --fix                  # apply automatic fixes
npx a11yfix src --fix --include-review # apply reviewable fixes too
npx a11yfix . --json                   # machine-readable
npx a11yfix . --all                    # include info findings and repeats
npx a11yfix --rules                    # list all 68 rules
```

Exit code is `1` when any error-severity finding remains, so it works as a CI gate.

Supported sources: `.html` `.jsx` `.tsx` `.vue` `.svelte` `.astro`, with `.css`/`.scss`
read for colour resolution. `.ts` and `.js` are deliberately not parsed as markup — they
usually contain HTML only inside string literals, and reporting on those is noise.

## GitHub Action

```yaml
- uses: iam-artificis/a11yfix@v1
  with:
    path: src
    mode: comment   # or: fail | pr
```

`comment` posts the findings on the pull request and updates the same comment on every
push, `fail` gates the build, `pr` opens a follow-up pull request containing the fixes.
`pr` never pushes to the branch under test.

## Verified, not asserted

Four properties are enforced by the test suite rather than claimed here:

- **Every diff applies.** Generated patches are round-tripped through real `git apply`
  and compared byte-for-byte against the direct edit — LF and CRLF, with and without a
  trailing newline, single-hunk and multi-hunk.
- **Every contrast value matches the WCAG reference.** The colour maths is checked
  against published ratios, and OKLCH conversion round-trips exactly.
- **Every ratio a fix claims to reach is the ratio it reaches.** The number in the report
  is recomputed from the palette step actually written, not from the solver's ideal.
- **No fix invents text.** A machine check asserts that nothing written into an `alt`,
  `aria-label`, `title` or `lang` position is anything but an empty value or a marked
  TODO.

## Precision

Tuned to miss a real issue rather than invent one, because a false positive costs a
developer an afternoon and their trust in everything else the tool said.

Measured against public repositories at the time of writing:

| Repository | Files | Findings |
|---|---|---|
| `vercel/commerce` | 45 | 6 |
| `tailwindlabs/tailwindcss.com` | 150 | 48 |
| `documenso/documenso` | 674 | 69 |
| `shadcn-ui/ui` | 3334 | 528 |

Getting there meant fixing five classes of confident, wrong finding that only real code
produced — a discarded Tailwind opacity modifier reading `bg-green-500/10` as solid
green, a stylesheet in one package colouring pages in another, `<Html>` from an email
library treated as the document root, markup inside a `dedent` block treated as a page.
Each is now a regression test.

## Install

```bash
npm install -D a11yfix
```

Zero runtime dependencies, by design. A tool you point at your source should not bring a
dependency tree with it.

## Licence

Apache-2.0.
