# Where A11yFix sits among the tools you already have

The honest short answer: **it does not replace any of them.** They answer "is the rendered
page accessible"; this answers "what do I change in the file". If you run one accessibility
tool, run axe. If you want the findings turned into a patch, add this.

## The tools

| | Runs on | Sees CSS | Contrast | Output |
|---|---|---|---|---|
| **axe-core** | Rendered DOM, in a browser | Yes — computed styles | Yes | A list of failing nodes |
| **Lighthouse** | Rendered DOM (bundles axe) | Yes | Yes | A score and a list |
| **Pa11y** | Rendered DOM, headless Chrome | Yes | Yes | A list |
| **eslint-plugin-jsx-a11y** | JSX source, per file | No | No | Lint errors, a few autofixes |
| **A11yFix** | Source: markup + CSS together | Yes — statically | Yes | A patch |

## Against axe-core, Lighthouse and Pa11y

They are better than this tool at what they do, and they do something different.

Running against a rendered page is the only way to know what a user actually gets. Every
runtime value is resolved, the cascade has already happened, and there is no guessing. A
serious accessibility practice runs axe.

What they cannot do is tell you which line to edit. A contrast failure comes back as a CSS
selector and a DOM path, and somebody has to work out which component produced that node,
which of four stylesheets set the colour, and what to change it to without breaking the
design. On a component library that translation is most of the effort.

There is also a coverage difference in both directions. They see pages that exist at test
time — whatever your crawler or test suite reached. A11yFix sees every file in the
repository, including the states and routes nobody wrote a test for. Neither set is a
superset of the other.

## Against eslint-plugin-jsx-a11y

This is the closest comparison and the one worth being precise about.

`eslint-plugin-jsx-a11y` is a static AST checker for accessibility rules on JSX elements,
it is excellent at what it covers, and if you write React you should already have it on.
It catches missing `alt`, bad ARIA, non-interactive elements with handlers, and it catches
them in your editor as you type.

Two things it does not do, by design:

**It does not see CSS.** It works one JSX file at a time and has no model of stylesheets,
Tailwind utilities, custom properties or the cascade. That rules out the entire contrast
family — the most common accessibility failure on the web — along with anything else that
depends on what an element actually renders as.

**It does not write cross-file fixes.** ESLint autofixes are local text edits inside one
file. Swapping `text-gray-400` for `text-gray-500` only after verifying the new shade
clears the ratio against a background inherited from an ancestor in another component is
not a shape an ESLint rule can express.

Where they overlap — missing `alt`, ARIA misuse, labelling — expect similar findings.
A11yFix additionally covers `.html`, `.vue`, `.svelte` and `.astro`, which the ESLint
plugin does not.

**Run both.** The plugin is the fast feedback loop while you type; this is the pass that
resolves colours and produces a patch.

## What none of them do

Refuse to guess, in writing.

Every tool in this table reports missing alternative text. Some products in the wider
market — the overlay vendors — go further and *generate* it, then report the page as
fixed. The Federal Trade Commission fined one of them for exactly that in 2025. A
plausible-sounding wrong description is worse than a missing one: it lies to a
screen-reader user and it silences every checker that would have caught it.

A11yFix never writes into an `alt`, `aria-label`, `title` or `lang` position except an
empty value or a marker that fails CI. That is not a promise in a readme; it is a test
that fails the build if a rule tries.

## When this tool is the wrong choice

- **You need a conformance statement.** No automated tool produces one. This one prints
  that on every run.
- **Your colours are computed at runtime**, from a CMS, a user theme, or a design-token
  pipeline that resolves outside your source. A11yFix will correctly say it does not know,
  which is useless to you. Run axe against the rendered result instead.
- **You want one tool.** Run axe.
