# What it finds on real code

Every number here is reproducible. Clone the commit named, run the command, compare.

```bash
git clone --depth 1 https://github.com/<repo>.git
npx a11yfix <repo> --json
```

Measured on 2026-08-31 with a11yfix 0.1.0.

| Repository | Commit | Files | Errors | Warnings | Info | Time |
|---|---|---|---|---|---|---|
| `vercel/commerce` | `3761e52` | 45 | 4 | 1 | 1 | 0.08s |
| `tailwindlabs/tailwindcss.com` | `bd868a3` | 150 | 26 | 14 | 7 | 0.21s |
| `documenso/documenso` | `5082b47` | 674 | 52 | 14 | 3 | 0.38s |
| `calcom/cal.com` | `176037d` | 989 | 828 | 542 | 12 | 0.59s |
| `shadcn-ui/ui` | `b4a618b` | 3334 | 100 | 71 | 357 | 1.32s |

These are well-built projects by people who care. The point of the table is not that they
are bad; it is that the numbers are small, which is what a precision-tuned tool should
produce, and that a scan of three thousand files finishes before you look away.

## Read the cal.com row properly

828 errors is not what it looks like. **1256 of its 1382 findings are in a single file**:
`apps/web/public/country-flag-icons/3x2/index.html`, a demo page vendored from an npm
package, listing 250 flags as unlabelled images inside unlabelled links.

The tool says so itself at the end of the run:

```
1256 of those 1382 findings are in one file: apps/web/public/country-flag-icons/3x2/index.html
If it is vendored or generated, exclude it before reading the rest.
```

Excluding it leaves 126 findings across 988 files, which is the number that means
something. The findings in that file are all technically correct — it really is 250
unnamed links — and none of them are cal.com's to fix.

This is the honest shape of static analysis on a monorepo, and it is why the report leads
with the count for the worst file rather than letting a reader scroll to that conclusion.

## What scanning live sites changed

Adding URL input turned a second kind of input on: hand-written CSS on a CMS, rather than
Tailwind classes in a repository. The first live scan found three defects that five
repositories and two hundred tests had never touched, all in the tool's flagship rule, and
all in the same direction — an unread background silently became the page default.

**A custom property in a `background` shorthand.** `background: var(--black)` is how
shm.ru sets its dark section. The shorthand reader looked for a token starting with `#`,
`rgb` or `hsl`, found none, and stored nothing — so the white headings inside it were
measured against the page default and reported as white on white. **Twenty-nine of the
thirty-two contrast findings on that page were that.** Custom properties are now followed
in the shorthand exactly as they already were in `color`.

**A value split on whitespace.** `var(--black, #000)` and `rgb(0, 0, 0)` contain spaces.
Splitting the value on whitespace left `var(--black,` and `#000)`, neither of which parses
as anything. Splitting now respects brackets.

**Silence where "unknown" was meant.** A `background` the reader could not classify set
neither a colour nor the unknown flag, and the ancestor walk stepped straight past it. The
rule now is that only a shorthand made purely of positions and repeats leaves an element
transparent; anything unrecognised is unknown, which suppresses the finding rather than
inventing one.

Two further changes came out of the same measurement:

**Text exactly the colour of its background is no longer reported.** 1.00:1 is not a
design anybody ships; it is what the tool computes when it did not see the real backdrop.
Across seven live sites this shape produced fifteen findings and none of them was real. A
genuine invisible-text bug now goes unreported, which is the trade this tool takes
everywhere: a false finding in a paid report discredits the true ones beside it.

**Descendant and compound selectors are read.** `.footer p { color: #999 }` is how people
write CSS by hand, and until now it styled nothing the tool could see. The old limit was
drawn on a sound principle — do not pretend to resolve a cascade you cannot see — but one
notch too tight: ancestry is a *fact* in the parsed markup, so `.card .title` is decidable,
while `:hover`, `[data-x]` and `+` are not and stay refused. This is a precision fix as
much as a coverage one: a rule that would have overridden the one we did apply, ignored,
turns legible text into a finding.

On the repository corpus this changed exactly one number. `calcom/cal.com` gained a single
error — `.email-footer p { color: #a8aaaf }` on `#f2f4f6`, 2.11:1, in an email template —
which is real, and which the tool could not previously see.

## What the calibration pass changed

The first run of this table looked very different, and every difference was the tool being
wrong. Five classes of confident false positive, none of which any synthetic test
produced:

**A discarded opacity modifier.** `bg-green-500/10` was read as solid green-500. A
translucent background renders close to whatever is behind it, so this did not understate
failures — it invented them. Eighteen of twenty-five contrast findings on `shadcn-ui/ui`
came from this alone. Alpha is now carried through and composited.

**Stylesheets crossing package boundaries.** `body { background-color: red }` in a test
fixture under `packages/shadcn/test/fixtures/` was colouring pages in
`templates/astro-monorepo/`. Five error-severity findings about a colour that appears
nowhere near those files. A stylesheet is now consulted only inside its own package, or
where the file names it in an import or a `<link>`.

**A component mistaken for an element.** `<Html>` from `@react-email/components` is an
email wrapper; `<Html>` from `next/document` is the page root. Twenty-eight "the `<html>`
element has no lang attribute" findings on `documenso/documenso` were the first kind. The
import line tells them apart, and the rule now reads it. A missing `lang` on
`next/document` — the case that matters — is still reported.

**Markup inside a template literal.** Every "document has no lang" finding on
`tailwindcss.com` came from a `dedent` block showing readers what an `index.html` looks
like. The tokeniser now masks template literals in JavaScript-family files, except ones
tagged `html`, because in lit-html that is the page.

**Text over a background image.** A hero with an `<img>` and a scrim behind white text,
inside a `<main class="bg-white">`, reads literally as white on white. The background walk
now stops at a positioned overlay that actually paints something, and at gradients and
background images, instead of reporting a pairing that never renders.

Each is a regression test in `test/precision.test.js`.

A sixth came out of checking this table by hand rather than trusting it: a
`<span class="text-pink-300">&middot;</span>` separator between two pieces of metadata
was reported at 1.81:1. Technically text, practically a bullet. WCAG 1.4.3 exempts pure
decoration, nobody is going to darken a dot, and a finding nobody acts on costs the
credibility of the five beside it. An element whose entire content is separator
punctuation is now skipped.

## Two rules that were wrong in principle

**`A11Y-IMG-006` fired on any `<svg>` with no accessible name.** That is the strict reading
of the spec and it is useless: a browser does not expose a role-less inline `<svg>` as an
image, and nearly every one in a real codebase is a decorative icon beside its own label.
102 findings across two production sites, none actionable, burying the genuine cases. It
now requires `role="img"` — the same line axe-core draws.

**`A11Y-IMG-007` required `focusable="false"` on hidden SVGs.** That attribute only ever
mattered in Internet Explorer and legacy Edge, dead since 2022 and 2021. The rule was
deleted.

## Where the tool is still wrong

Stated plainly, because a report that only lists successes is not a measurement.

- **`A11Y-LINK-007` is 60% of the output on `shadcn-ui/ui`** — 317 anchors with
  `href="#"`, nearly all placeholders in example files. The claim is true and the priority
  was not, so a placeholder with no handler is now `info` and not listed by default. It is
  still a large fraction of the total count.
- **Vue and Svelte are handled as markup, not by their own compilers.** In practice this
  works better than it sounds: `@click` and `on:click` are recognised as handlers,
  `{#if}` blocks and `<script>` contents are not mistaken for markup, and Tailwind
  classes resolve normally. What is missed is anything only the framework compiler knows —
  scoped-style specificity, `v-bind` objects, slot content, and props threaded through a
  component boundary.
- **The cascade is not evaluated.** Media queries, container queries, `:hover`, dark mode
  and any colour behind a runtime expression are skipped rather than guessed. On a
  codebase built entirely on design tokens resolved at runtime, the contrast rules will
  correctly find nothing, which is not the same as there being nothing to find.
- **A component library that themes through CSS custom properties gets less coverage than
  one with literal colours.** `shadcn-ui/ui` produced zero contrast findings for exactly
  this reason. That is the tool refusing to guess, but it is still a gap.

## Reproducing the repository table

```bash
for repo in vercel/commerce tailwindlabs/tailwindcss.com documenso/documenso \
            calcom/cal.com shadcn-ui/ui; do
  dir=$(echo "$repo" | tr / _)
  git clone --depth 1 -q "https://github.com/$repo.git" "$dir"
  npx a11yfix "$dir" --json | node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      const t=JSON.parse(s).totals;
      console.log(process.argv[1], t.errors, t.warnings, t.info);
    });' "$repo"
done
```

Counts will drift as those projects change. The commits in the table are pinned so the
exact numbers stay checkable.

## A second measurement: nine Russian institutional sites

The table above is Western open source, where the tool reads a repository. This one is
different work and narrower: nine live `.ru` sites of libraries, museums and regulators,
scanned over HTTP on 2026-08-31.

Two things follow from that, and neither is small. There is no repository, so there is no
patch — the tool can say what is wrong but not fix it. And a client-rendered application
serves an empty shell to anything that is not a browser, which is why `msu.ru` returns two
findings: there is no page there to read. The tool says so itself rather than reporting a
near-clean result.

| Site | Errors | Warnings | Info | Overlay | Total |
|---|---|---|---|---|---|
| `shm.ru` | 158 | 94 | 112 | 4 | 364 |
| `spbu.ru` | 178 | 10 | 66 | 2 | 254 |
| `rsl.ru` | 129 | 18 | 67 | — | 214 |
| `obrnadzor.gov.ru` | 77 | 58 | 63 | — | 198 |
| `nlr.ru` | 34 | 52 | 34 | 2 | 120 |
| `tretyakovgallery.ru` | 40 | 21 | 48 | — | 109 |
| `rusmuseum.ru` | 10 | 14 | 18 | — | 42 |
| `libnn.ru` | 24 | 13 | 5 | — | 42 |
| `msu.ru` (app shell) | 1 | 1 | 0 | — | 2 |

Read the 1345 total with the same suspicion the cal.com row deserves. 243 of the warnings
are `target="_blank"` without `rel="noopener"` and 230 of the info findings are a new
window opened without warning — conventions, and on this evidence near-universal ones.
Strip those and 872 remain, of which the load-bearing part is:

- **238 pieces of text** below the contrast their size requires;
- **172 images** with no `alt` at all (50) or an `alt` that is a file name or a placeholder (122);
- **134 links** with no discernible text — an icon, or an image with no `alt`, and nothing else;
- **36 elements** carrying `role="img"` with no accessible name.

### The finding the whole rule set is built around

Three of the nine carry a «версия для слабовидящих» switch, and A11Y-DOC-016 found all
three — twice by the link's own text, twice by an `<input type="submit">` whose only label
is its `value`, and four times on one site by the `bvi` stylesheet, script and the two
buttons that open it.

On all three, the barriers the switch cannot touch are present anyway:

| Site | Images with no alt | Placeholder alt | Links with no text |
|---|---|---|---|
| `shm.ru` | 30 | 40 | 14 |
| `nlr.ru` | 8 | 21 | — |
| `spbu.ru` | 1 | 2 | 69 |

This is the argument, measured rather than asserted: the switch changes the size and the
colour of the page for a reader with some sight left, and leaves a reader with none
exactly where they were. It is also why the rule is `info` and its advice does not say to
remove anything. A font-size and contrast control is genuinely useful. It is only a
problem when it is mistaken for the work.

### Reproducing this table

```bash
for u in shm.ru spbu.ru obrnadzor.gov.ru rsl.ru nlr.ru \
         tretyakovgallery.ru rusmuseum.ru libnn.ru msu.ru; do
  npx a11yfix "https://$u/" --json | node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      const t=JSON.parse(s).totals;
      console.log(process.argv[1], t.errors, t.warnings, t.info);
    });' "$u"
done
```

Live sites change without notice, so unlike the repository table these numbers are not
pinned and will drift. What should not drift is the shape: a small number of rules
accounting for most of the findings, and the overlay sitting on top of them.
