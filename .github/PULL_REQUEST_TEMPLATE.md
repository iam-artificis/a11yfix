<!--
  Four properties are enforced by the test suite rather than by review. If your change
  touches a rule, a fix or the diff writer, say below which of them you re-checked and how.
-->

## What this changes

## Why

<!-- The reason, not the restatement. A comment recording a decision somebody would
     otherwise undo is worth more than a comment describing the line under it. -->

## Checks

- [ ] `npm test` passes locally (Windows too, if you touched patch generation)
- [ ] `npm run docs` run and `docs/coverage.md` committed, if the rule set changed
- [ ] A test for the case where the new behaviour must stay **silent**
- [ ] Russian text added, if a rule or message was added
- [ ] No new dependencies
