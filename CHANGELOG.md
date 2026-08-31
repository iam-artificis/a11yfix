# Changelog

## 0.1.0 — unreleased

First release.

- 69 rules across contrast, images and media, forms, document structure, keyboard
  operability, ARIA, and links, each anchored to the WCAG 2.2 success criterion it
  implements. `docs/coverage.md` is generated from the rule set, so it cannot overstate
  what is covered.
- Contrast repair in OKLCH: hue held fixed, lightness moved by the minimum needed, chroma
  reduced only when the result would leave sRGB. Moves whichever side of the pair costs
  less, and refuses a change large enough to alter the design.
- Colour resolution across markup and CSS together — stylesheets, inline styles, Tailwind
  utilities including opacity modifiers, CSS custom properties and Tailwind v4 `@theme`
  tokens — with a stated provenance for every value and silence where the value is not
  determinable.
- Patches are emitted as a unified diff and round-tripped through real `git apply` in the
  test suite, across LF and CRLF, with and without a trailing newline.
- GitHub Action with `comment`, `fail` and `pr` modes. `pr` never pushes to the branch
  under test.
- Zero runtime dependencies.

Calibrated against `vercel/commerce`, `tailwindlabs/tailwindcss.com`,
`documenso/documenso`, `shadcn-ui/ui` and `calcom/cal.com`. That pass found five classes
of confident false positive that no synthetic fixture produced, each now a regression
test:

- A discarded Tailwind opacity modifier read `bg-green-500/10` as solid green, inventing
  eighteen of twenty-five contrast findings on one repository.
- A stylesheet in one package coloured pages in another.
- `<Html>` from an email library was treated as the document root.
- Markup inside a `dedent` template literal was treated as a page.
- Text over a hero image was measured against an assumed white background.

A pre-launch adversarial review found thirty defects. The four critical ones were all the
same shape — the tool leaving a repository worse than not running it — and all four are
closed:

- A quote inside a comment or a regex made `scanBraces` swallow the rest of the module,
  so `--fix` wrote an attribute past the end of the file.
- The contrast solver re-attached the source alpha to a colour it had solved as opaque,
  so a fix could halve the ratio it reported having raised.
- `--fix --include-review` could silence the missing-`lang` error permanently. It cannot
  now, and `A11Y-TODO-001` reports any marker left in a file as an error.
- A wrapper element was blamed for text that lives in its children.

Also from that review, and from the corpus run that follows it:

- `--diff` now previews every fix a human would review, not only the automatic ones.
  The README's own headline command printed "No fixable violations found." on the
  README's own example file.
- `--mark-todos` writes the placeholder markers for findings only a person can decide.
  Every marker-writing rule was `manual`, which no threshold admits, so the mechanism
  the documentation describes could never actually run.
- `A11Y-FORM-002` no longer copies a placeholder into `aria-label`. Placeholders carry
  example values as often as names, and announcing "e.g. jane@example.com" as a field's
  name is worse than announcing nothing — it also silences every checker downstream.
- One scanner now reads both `{…}` attributes and `${…}` interpolations. Two of them
  disagreed about a template literal nested inside a JSX attribute, and 280 lines of a
  real component stopped being parsed without any error.
- `flatten` rounds to 8-bit channels, so the half that verifies a fix and the half that
  measures it agree to the last decimal.
- Stylesheet rules are ranked by specificity, and `em`/`%` font sizes resolve up the
  ancestor chain or stay honestly unknown.

Four quadratic loops and two exponential regexes, all reachable from ordinary input:

- A list written without closing tags — legal HTML, and what most generators emit —
  made every `<li>` scan to the end of the document for a `</li>` that is not there.
- Every violation counted newlines from byte 0 again, so a file with many findings
  walked its own bytes once per finding.
- Contrast asked "is anything painted over me?" by comparing each element to all of its
  siblings, once per element.
- Every element was tested against every CSS rule, re-parsing each selector each time.
- An ignore pattern of `**/**/…` compiled to nested `.*` groups: eight of them took five
  seconds to *fail* on an ordinary path, and patterns come out of a user's config file.
- `IMPORT_RE` put two lazy runs next to each other, so a long whitespace run after the
  word `import` backtracked quadratically.

`test/scale.test.js` covers each with a bound a hundredfold above the fixed timing, so it
fails on a change in complexity and not on a slow machine. Findings on all five corpora
are byte-identical; `shadcn-ui/ui` went from 1.58s to 1.32s and `calcom/cal.com` from
0.77s to 0.55s.
