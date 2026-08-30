import type { Rule, Violation } from '../types.js';
import { TODO_MARKER } from '../types.js';

/**
 * Report every A11YFIX-TODO marker still in the source.
 *
 * Several rules deliberately decline to invent text and instead patch in a placeholder:
 * an `aria-label` containing the marker, a `<title>` containing the marker, an `href`
 * pointing at it. The README's claim about those is precise — "reported with a marker
 * that fails CI until a person writes the words" — and until this rule existed the claim
 * was false in the worst possible direction. Eight rules wrote the marker; nothing
 * anywhere read it. `--fix --include-review` therefore *removed* the error: the attribute
 * now existed, the rule that had been complaining fell silent, and a page with no
 * accessible name reported clean and exited 0.
 *
 * That is the exact failure this tool is built to argue against, so the marker gets a
 * rule of its own rather than a check inside each rule that writes one. A single
 * mechanism cannot drift out of sync with itself, and a rule that scans for one literal
 * string cannot be wrong about whether the string is there.
 *
 * It is deliberately not tied to a WCAG criterion. Nothing in WCAG says anything about
 * this string; the finding means "a fix here is half-finished", which is the tool's own
 * bookkeeping and should read that way in a report.
 */
const todoMarkerLeft: Rule = {
  id: 'A11Y-TODO-001',
  title: 'An A11yFix placeholder is still in the source',
  wcag: [],
  level: 'A',
  severity: 'error',
  summary:
    'A fix left a A11YFIX-TODO placeholder for a human to complete, and it is still there.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx): Violation[] {
    const out: Violation[] = [];
    const source = ctx.source;

    let from = 0;
    for (;;) {
      const at = source.indexOf(TODO_MARKER, from);
      if (at < 0) break;
      from = at + TODO_MARKER.length;

      // Show the whole attribute or element the marker sits in, not the bare token: the
      // point of the finding is to send somebody to the right spot, and "A11YFIX-TODO"
      // on its own says nothing about which of them this is.
      const lineStart = source.lastIndexOf('\n', at) + 1;
      const lineEnd = source.indexOf('\n', at);
      const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);

      out.push(
        ctx.report({
          ruleId: todoMarkerLeft.id,
          wcag: todoMarkerLeft.wcag,
          level: todoMarkerLeft.level,
          severity: todoMarkerLeft.severity,
          start: at,
          end: from,
          message: 'An A11yFix placeholder is still here; the text it stands in for was never written.',
          impact:
            'The element has a name, so every automated checker downstream now reports ' +
            'it as fixed — including this one, if the marker is removed without writing ' +
            'anything in its place. A screen-reader user hears the placeholder read out ' +
            'instead of a description, which is worse than hearing nothing: it looks ' +
            'deliberate.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Replace the placeholder with the real text.',
            advisory:
              'Write what this element is or does, in the words a person would use, and ' +
              'delete the placeholder: ' +
              line.trim().slice(0, 160),
          },
        }),
      );
    }
    return out;
  },
};

export const TODO_RULES: readonly Rule[] = [todoMarkerLeft];
