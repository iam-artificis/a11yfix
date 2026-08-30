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
emits a patch. It scans 3,300 files in 1.6 seconds, needs no browser, no
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

Beyond contrast, 69 rules cover images and media alternatives, form labelling, document
structure, keyboard operability, ARIA correctness, and link semantics — each anchored to
the WCAG success criterion it implements.

## What a run looks like

Every finding names who is affected, quotes the source, and says what the patch would do
and what it would achieve.

```
demo/Card.tsx
  4:7  error    Text contrast is 2.54:1, below the required 3:1 (#9ca3af on #ffffff). WCAG 1.4.3
          People with low vision, colour vision deficiency, or anyone reading on a phone
          in sunlight cannot reliably make out this text.
          <h2 className="text-gray-400 text-2xl font-bold">
          fixable (review): Replace text-gray-400 with text-gray-500, reaching 4.83:1.
          A11Y-COLOR-001

3 findings  (3 errors, 0 warnings)  across 1 file
0 fixable automatically, 3 fixable with review, 0 need a person.
Run with --fix to apply, or --diff to preview.
```

That "reaching 4.83:1" is recomputed from the shade the patch actually writes, not from
the ideal colour the solver aimed at. It is a number you can check.

## What it will never do

**It does not invent alt text.** It cannot see the image. A plausible-sounding wrong
description is worse than a missing one: it lies to a screen-reader user *and* makes
every downstream checker report the page as fixed. Same for link text, button labels, and
`lang`. Those are reported and never patched: the finding stays, and the exit code stays
1, until a person writes the words.

Where a fix does leave a placeholder for someone to complete, `A11Y-TODO-001` reports the
placeholder itself as an error, so an unfinished fix cannot pass as a finished one.

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
npx a11yfix --rules                    # list all 69 rules
npx a11yfix . --baseline-write         # record existing findings, then gate on new ones
npx a11yfix . --baseline               # report only what is not in the baseline
npx a11yfix . --report                 # standalone HTML audit report
```

Exit code is `1` when any error-severity finding remains, so it works as a CI gate.

## A report for people who will not run a CLI

```bash
npx a11yfix . --report              # writes a11yfix-report.html
```

One self-contained HTML file — no scripts, no fonts, no images, nothing to fetch — that
opens offline, prints, and survives being emailed. It groups findings by rule, names the
file and line for every one of them, quotes the source that triggered it, and links each
rule to the W3C's own page for the criterion it belongs to.

By default it lists the first twelve occurrences of each rule and says how many it left
out. `--report --all` lists every one, which is what you want when the file is going to
somebody as a deliverable rather than being skimmed.

It states what the tool cannot check *before* the findings rather than after. A report
that lets a passing automated scan imply conformance is the thing the FTC fined an
overlay vendor for, and burying the caveat at the bottom is how that happens.

## Adopting on a project that already has findings

The first run on an existing application is not going to be zero. A real one produced
1381 findings, and nobody fixes 1381 things before merging the next feature. Record them
once and gate on the difference:

```bash
npx a11yfix . --baseline-write   # writes .a11yfix-baseline.json — commit it
npx a11yfix . --baseline         # in CI: exit 1 only on findings that are not in it
```

Findings are matched by rule, file and the *shape* of the code — whitespace collapsed,
quotes unified — never by line number. Editing lines above a finding, or running the
file through a formatter, does not make it look new. A second copy of an already-known
violation is known; a third is new.

When findings in the baseline stop occurring, the run says so and suggests rewriting it,
so the file shrinks as the codebase improves instead of quietly accumulating permission
to regress.

## Configuration

`.a11yfixrc.json` in the project root, or an `a11yfix` key in `package.json`. A
command-line flag always wins over the file.

```json
{
  "level": "AA",
  "ignore": ["apps/web/public/**", "**/*.stories.tsx"],
  "rules": { "A11Y-LINK-007": "off" }
}
```

The same thing from the command line: `--ignore "apps/web/public/**" --disable A11Y-LINK-007`.

For a single justified exception, a comment in the file beats turning the rule off
everywhere:

```html
<!-- a11yfix-disable-next-line A11Y-IMG-001 -->
<img src="divider.png">
```

`a11yfix-disable-line` and `a11yfix-disable-file` work too, in HTML comments and in JSX
`{/* … */}` comments. Naming no rule suppresses every rule on that line. There is
deliberately no "disable from here on" — a blanket switch buried mid-file is
indistinguishable from the tool being broken, and nobody ever finds it again.

Suppressions that stop matching anything are reported by file and line, so they cannot
quietly outlive the problem they were written for.

Every run prints which config it used, how many files were ignored and how many rules are
off, so a finding that never appears can be traced to the line that silenced it.

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

| Repository | Files | Errors | Warnings |
|---|---|---|---|
| `vercel/commerce` | 45 | 4 | 1 |
| `tailwindlabs/tailwindcss.com` | 150 | 26 | 14 |
| `documenso/documenso` | 674 | 52 | 14 |
| `calcom/cal.com` | 989 | 827 | 542 |
| `shadcn-ui/ui` | 3334 | 100 | 71 |

Getting there meant fixing five classes of confident, wrong finding that only real code
produced — a discarded Tailwind opacity modifier reading `bg-green-500/10` as solid
green, a stylesheet in one package colouring pages in another, `<Html>` from an email
library treated as the document root, markup inside a `dedent` block treated as a page.
Each is now a regression test. The full write-up, with pinned commits and the cases where
the tool is still wrong, is in [docs/field-report.md](docs/field-report.md).

## Install

```bash
npm install -D a11yfix
```

Zero runtime dependencies, by design. A tool you point at your source should not bring a
dependency tree with it.

## Licence

Apache-2.0.
