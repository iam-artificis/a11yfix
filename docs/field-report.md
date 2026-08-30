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
| `tailwindlabs/tailwindcss.com` | `bd868a3` | 150 | 27 | 14 | 7 | 0.23s |
| `documenso/documenso` | `5082b47` | 674 | 52 | 14 | 3 | 0.38s |
| `calcom/cal.com` | `176037d` | 989 | 827 | 542 | 12 | 0.77s |
| `shadcn-ui/ui` | `b4a618b` | 3334 | 100 | 71 | 357 | 1.58s |

These are well-built projects by people who care. The point of the table is not that they
are bad; it is that the numbers are small, which is what a precision-tuned tool should
produce, and that a scan of three thousand files finishes before you look away.

## Read the cal.com row properly

827 errors is not what it looks like. **1256 of its 1381 findings are in a single file**:
`apps/web/public/country-flag-icons/3x2/index.html`, a demo page vendored from an npm
package, listing 250 flags as unlabelled images inside unlabelled links.

The tool says so itself at the end of the run:

```
1256 of those 1381 findings are in one file: apps/web/public/country-flag-icons/3x2/index.html
If it is vendored or generated, exclude it before reading the rest.
```

Excluding it leaves 125 findings across 988 files, which is the number that means
something. The findings in that file are all technically correct — it really is 250
unnamed links — and none of them are cal.com's to fix.

This is the honest shape of static analysis on a monorepo, and it is why the report leads
with the count for the worst file rather than letting a reader scroll to that conclusion.

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
- **Vue and Svelte are parsed as HTML.** `<script setup>`, reactive expressions and
  framework-specific directives are not understood. Findings in those files are limited to
  what plain markup analysis can see.
- **The cascade is not evaluated.** Media queries, container queries, `:hover`, dark mode
  and any colour behind a runtime expression are skipped rather than guessed. On a
  codebase built entirely on design tokens resolved at runtime, the contrast rules will
  correctly find nothing, which is not the same as there being nothing to find.
- **A component library that themes through CSS custom properties gets less coverage than
  one with literal colours.** `shadcn-ui/ui` produced zero contrast findings for exactly
  this reason. That is the tool refusing to guess, but it is still a gap.

## Reproducing the table

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
