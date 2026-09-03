# Changelog

## 0.1.1 — 2026-09-03

A security release. 0.1.0 followed redirects with `redirect: 'follow'`, which does the
following inside undici where there is no hook to refuse a hop — so a public page could
send a scan into the network the scan was run from, and the result came back in the
report. Upgrade if you ever point this tool at a URL somebody else gave you.

- **A scan that starts on the public internet is refused when a redirect would take it
  into a private network.** Redirects are followed here rather than by `fetch`, and each
  hop's host is resolved before it is judged — `127.0.0.1.nip.io` is a public name
  pointing at loopback and anyone can register another. A scan that starts private is
  your own network already and follows its redirects normally, so
  `a11yfix http://localhost:3000` is unaffected.
- **Addresses are classified by their bytes, not by how they are spelled.**
  `http://[::ffff:127.0.0.1]/` is normalised by `new URL` to `[::ffff:7f00:1]`, and the
  text-matching check this replaces read that as public. IPv4-mapped and IPv4-compatible
  IPv6, NAT64, unique-local, link-local and site-local are all covered.
- **A sitemap index may only name child sitemaps on the origin it came from.** It was the
  shortest path in the tool from "scan my site" to a request against `169.254.169.254`
  with the reply parsed and reflected into the report — page URLs were filtered to the
  origin, the child sitemaps naming them were not.
- **The redirect timeout is one budget for the whole chain**, not one per hop, and the
  cap is 10 rather than 5 — the number browsers use.
- A `Location` header carrying raw UTF-8 resolves to the path the server meant.
  Header bytes arrive decoded as latin1, and passing that to `new URL` percent-encodes
  the mojibake: `%C3%91%C2%81` where the server meant `%D1%81`. undici does this
  recovery internally, so following redirects by hand had to do it too.
- `SECURITY.md` states the limit of the guarantee rather than glossing it: the address is
  resolved to decide and resolved again to connect, and pinning the two together needs a
  custom undici dispatcher that zero runtime dependencies rules out.

Four criteria that did not fit the finding they were attached to. Each was a citation of
the standard's authority for a claim the standard does not make, and the reader most
likely to check is the one holding a conformance obligation:

- `A11Y-DOC-006` cites 1.3.1 and 4.1.2 for a duplicate `id` only when an
  `aria-labelledby`, a `<label for>` or one of eleven other IDREF attributes resolves to
  it. 4.1.1 Parsing, which covered it outright, was removed in WCAG 2.2.
- `A11Y-FORM-003` cites 1.3.1 when two radios without a shared `name` could have been a
  group. A single one has no group to have broken, and now reads as the field bug it is.
- `A11Y-IMG-008` cites 1.2.2 for `<video>` and 1.2.1 for `<audio>`, rather than both for
  both: audio-only wants a transcript, not captions, which is what its own advice said
  while it cited the wrong criterion beside it.
- `A11Y-LINK-008` cites nothing. 2.4.4 Link Purpose is about whether the link text says
  where it goes; a link whose text is perfect and whose target does not exist passes it.

Publishing now runs from CI under npm trusted publishing: the registry authenticates the
workflow by the OIDC identity GitHub mints for it, so there is no token in this
repository to rotate or to leak.

Also: `--fix` no longer crashes on a colour named after a prototype member
(`background: constructor`), a file the parser cannot read is a finding about that file
instead of the end of the run, and the CLI sets `process.exitCode` rather than calling
`process.exit`, which on Windows could abort the process before stdout was flushed.

## 0.1.0 — 2026-09-03

First release.

- 70 rules across contrast, images and media, forms, document structure, keyboard
  operability, ARIA, and links. 59 name the WCAG 2.2 success criterion they implement;
  the other 11 are practice WCAG has no criterion for, reported as warnings or
  information — except `A11Y-TODO-001`, which reports this tool's own unfinished fix and
  is an error on purpose. `docs/coverage.md` is generated from the rule set, so it cannot overstate
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

The audit report can be produced in Russian: `--report audit.html --lang ru`. Only the
report is translated — the terminal is read by whoever ran the command, the report by
whoever commissioned the work, and in the market where ГОСТ Р 52872-2019 gets written
into a procurement contract that second person may not read English at all. All 70 rules
have Russian text and a test fails the build if one is added without it; a second test
fails if any line the report writes about itself is left in English. Where a patch is
offered, the change itself — `text-gray-400 → text-gray-600` — appears in both languages,
because that is the line a reader checks against their own file.
