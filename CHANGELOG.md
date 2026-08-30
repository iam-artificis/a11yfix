# Changelog

## 0.1.0 — unreleased

First release.

- 68 rules across contrast, images and media, forms, document structure, keyboard
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
