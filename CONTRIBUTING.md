# Contributing

The most useful thing you can send is **a false positive**.

This tool is tuned to miss a real issue rather than invent one, because a wrong finding
costs a developer an afternoon and their trust in everything else it said. Every case
where it was confidently wrong on real code has become a regression test, and the five
that mattered most came from running it against other people's repositories rather than
from anything a fixture produced. If it reported something on your code that is not
true, that is the highest-value report this project can receive.

## Reporting

Open an issue with the template that fits:

- **False positive** — a finding that is wrong. The smallest snippet that reproduces it
  is worth more than a link to a repository.
- **Missed violation** — something a rule should have caught and did not.
- **Bug** — a crash, a patch that does not apply, a wrong number.
- **New rule** — name the WCAG success criterion first. A rule without one is a style
  preference, and this tool does not ship those. `A11Y-DOC-016` is the single deliberate
  exception and it is reported as `info`.

For anything security-related, see [SECURITY.md](SECURITY.md) rather than the issue
tracker.

## Working on it

```bash
npm ci
npm test          # builds, checks characters, then runs the suite
npm run docs      # regenerates docs/coverage.md from the rule set
```

Node 20 or newer. There are no runtime dependencies and there will not be any: a tool you
point at your source should not bring a dependency tree with it. Build-time
`devDependencies` are TypeScript and its Node types, and that list is also meant to stay
where it is.

## What a change has to hold

CI runs on Linux and Windows across Node 20, 22 and 24. Windows is not optional here —
the diff round-trip runs real `git apply`, and line endings are exactly the thing that
breaks a patch.

Four properties are enforced by tests rather than by review, and a change that breaks one
of them is wrong even if it looks right:

1. **Every diff applies.** Patches are round-tripped through `git apply` and compared
   byte-for-byte against the direct edit — LF and CRLF, with and without a trailing
   newline, single-hunk and multi-hunk.
2. **Every ratio a fix claims to reach is the ratio it reaches**, recomputed from the
   palette step actually written, not from the solver's ideal.
3. **No fix invents text.** A machine check asserts that nothing written into an `alt`,
   `aria-label`, `title` or `lang` position is anything but an empty value or a marked
   TODO. If your rule needs to write a word a person should have chosen, the answer is
   that it reports and does not fix.
4. **`docs/coverage.md` matches the rule set.** It is generated. Run `npm run docs` and
   commit the result, or CI will tell you the repository is making a coverage claim the
   code does not support.

## Adding a rule

- Pick the WCAG 2.2 success criterion it implements and put its id in the rule.
- Give it an accurate `fixability`: `automatic` means one provably correct answer
  independent of context, `review` means correct in the common case, `manual` means
  advice only. When in doubt, go one level weaker.
- Write the Russian text. A test fails the build if a rule ships without it — a report
  handed to somebody in a procurement conversation is often read by a person who does not
  read English compiler output all day.
- Say who is affected and why, in the finding itself. "Fails 1.4.3" tells a developer
  nothing about whether to care.
- Add a test for the case where the rule must stay silent. That test is the point.

## Style

Match what is there. Comments explain **why**, and the ones worth writing are the ones
that record a decision somebody would otherwise undo — this codebase has several, and
they are the reason it does not regress. British spelling, `colour` in prose and `color`
in code. No new dependencies.

## Licence

Contributions are accepted under Apache-2.0, the same licence as the project.
