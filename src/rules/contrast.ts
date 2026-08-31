import type { Edit, Rule, Violation } from '../types.js';
import type { Element } from '../parse/markup.js';
import { getAttr, textOf } from '../parse/markup.js';
import type { ResolvedColor } from '../design/palette.js';
import type { RGB } from '../color.js';
import {
  contrastRatio,
  relativeLuminance,
  flatten,
  parseColor,
  repairPair,
  requiredRatio,
  toHex,
} from '../color.js';
import { familyOf, rampFrom, shadeOf, nearestShade, resolveTailwindColor } from '../design/tailwind.js';

/**
 * Contrast rules — the reason this tool exists.
 *
 * Low-contrast text is the most common accessibility failure in the world and the only
 * common one a machine can genuinely repair, because the correct answer is arithmetic
 * rather than judgement. Everything else in A11yFix reports; this fixes.
 *
 * Three properties keep it trustworthy:
 *
 *  - It only speaks when it knows. If either colour cannot be resolved from source, the
 *    element is skipped silently rather than guessed at.
 *  - It moves the smallest possible distance in perceptual space, and prefers changing
 *    whichever side of the pair moves less.
 *  - When even the minimal change is large enough to alter the design, it refuses to
 *    patch and says so. A checker that quietly turns a brand button charcoal is worse
 *    than one that says "this needs a human".
 */

/** Elements that never render text of their own. */
const NON_TEXT_TAGS = new Set([
  'script', 'style', 'head', 'meta', 'link', 'title', 'br', 'hr', 'img', 'input',
  'svg', 'path', 'circle', 'rect', 'g', 'source', 'track', 'template', 'base', 'col',
]);

interface Pair {
  readonly fg: ResolvedColor;
  readonly bg: ResolvedColor;
  /** Non-null: pairFor returns null rather than a pair with an unresolved colour. */
  readonly fgRgb: RGB;
  readonly bgRgb: RGB;
}

/** Resolve a usable colour pair, or nothing when either side is undetermined. */
function pairFor(el: Element, ctx: { palette: import('../design/palette.js').Palette }): Pair | null {
  const fg = ctx.palette.foregroundFor(el);
  const bg = ctx.palette.backgroundFor(el);
  if (fg === undefined || bg === undefined) return null;

  // currentColor, inherit and var() indirection all resolve at render time against
  // information we do not have. Reporting a ratio for them would be invention.
  if (/^(currentcolor|inherit|initial|unset|revert)$/i.test(fg.value.trim())) return null;
  if (/^(currentcolor|inherit|initial|unset|revert)$/i.test(bg.value.trim())) return null;
  if (fg.value.includes('var(') || bg.value.includes('var(')) return null;

  const fgRgb = parseColor(fg.value);
  const bgRgb = parseColor(bg.value);
  if (fgRgb === null || bgRgb === null) return null;

  // Text that is invisible against a background we only assumed is evidence about the
  // assumption, not about the code. Nobody writes color: white meaning it to land on
  // white; when no element in the ancestry declared a background at all and the pair
  // comes out at almost no contrast, the missing half is a theme, a gradient or a media
  // query we cannot see. Reported anyway, this was an error-severity finding on a
  // Next.js _document that contains no colours whatsoever.
  //
  // The bar is deliberately just above nothing: grey on white at 2.5:1 is a real and
  // very common design mistake and stays reported.
  if (bg.provenance === 'default' && contrastRatio(fgRgb, bgRgb) < 1.5) return null;

  // The same argument, one step further, for a background that *was* declared.
  //
  // Text computed to be exactly the colour of what it sits on is not a design anybody
  // ships; it is the signature of a backdrop this tool could not see — a hero image on a
  // preceding sibling, a class a script adds, a rule under a selector the cascade here
  // does not implement. On seven live Russian institutional sites this shape accounted
  // for fifteen findings and not one of them was real, while the genuine complaint the
  // tool exists to make — grey on white at 2.5:1 — is nowhere near this line.
  //
  // The cost is a real invisible-text bug going unreported. That trade is the one this
  // tool takes everywhere else: a false finding in a paid report discredits the true
  // ones next to it, and a missed one costs only itself.
  const bgOpaque: RGB = { ...bgRgb, a: 1 };
  if (toHex(flatten(fgRgb, bgOpaque)) === toHex(bgOpaque)) return null;

  return { fg, bg, fgRgb, bgRgb };
}

/**
 * Characters that carry no information on their own.
 *
 * A `<span>` holding nothing but `&middot;` between two pieces of metadata is a visual
 * separator, and WCAG 1.4.3 exempts text that is pure decoration. Reporting it is
 * technically defensible and practically wrong: nobody is going to darken a dot, and a
 * finding nobody acts on costs the credibility of the ones next to it. A separator inside
 * a sentence is unaffected — the element's own text is then the whole sentence.
 */
const SEPARATOR_ONLY =
  /^(?:[\s|/\\\u00b7\u2022\u2013\u2014\u2022\u22c5\u2027\u30fb\-]|&(?:middot|bull|bullet|mdash|ndash|sdot|nbsp|#(?:183|8226|8211|8212|160|8901));)+$/i;

/** Does this element render text directly, rather than only through children? */
function hasOwnText(el: Element): boolean {
  if (NON_TEXT_TAGS.has(el.tagLower)) return false;
  // Only count text that is not entirely inside a child element, so a wrapper <div>
  // is not blamed for the contrast of a <span> that sets its own colour.
  //
  // Walk the gaps between children rather than deleting each child from the string. The
  // deleting version computed offsets against the original innerSource and applied them
  // to an accumulator that had already shrunk, so from the second child onward it cut
  // the wrong range — or, more often, an empty one, leaving every child's text behind.
  let kept = '';
  let cursor = 0;
  for (const child of el.children) {
    const start = child.openStart - el.openEnd;
    const stop = child.end - el.openEnd;
    // Guarded rather than assumed sorted: the parser is deliberately tolerant of
    // malformed markup, and overlapping siblings would otherwise reintroduce the bug.
    if (start > cursor) kept += el.innerSource.slice(cursor, start);
    if (stop > cursor) cursor = stop;
  }
  const withoutChildren = kept + el.innerSource.slice(cursor);
  const own = withoutChildren.replace(/<[^>]*>/g, ' ');
  const literal = own.replace(/\{[^}]*\}/g, ' ').trim();
  if (literal !== '') return !SEPARATOR_ONLY.test(literal);

  // A JSX expression is usually the text. `<h2 className="text-gray-400">{title}</h2>`
  // renders a heading, and skipping it because the words are not literal would exclude
  // most of the text in any React application — the readme's own example among them.
  //
  // What is skipped is an expression that plainly renders no text of its own: a comment,
  // or one that contains nested markup, where the child element carries its own colour
  // and is checked in its own right.
  for (const m of own.matchAll(/\{([\s\S]*?)\}/g)) {
    const body = (m[1] ?? '').trim();
    if (body === '') continue;
    if (body.startsWith('/*') || body.startsWith('//')) continue;
    if (body.includes('<')) continue;
    return true;
  }
  return false;
}

/**
 * Build the edit that rewrites a colour.
 *
 * In a Tailwind codebase the right patch swaps `text-gray-400` for `text-gray-600`, not
 * one that bolts a hex literal onto a file that has no hex literals in it. A patch that
 * does not look like the surrounding code gets reverted in review however correct it is.
 */
/**
 * The edit that rewrites a colour, together with the ratio it really reaches.
 *
 * The achieved ratio is returned rather than assumed because a Tailwind swap lands on a
 * palette step, not on the ideal colour: the report has to quote the number the developer
 * will measure after applying the patch, not the one the solver aimed at.
 */
interface ColourEdit {
  readonly edit: Edit;
  readonly achieved: number;
}

function buildEdit(
  source: ResolvedColor,
  newHex: string,
  verify: (candidate: RGB) => number,
  required: number,
  wholeSource: string,
  label: string,
): ColourEdit | null {
  const span = source.span;
  if (span === undefined) return null;

  if (source.tailwindClass !== undefined) {
    const family = familyOf(source.tailwindClass);
    const current = shadeOf(source.tailwindClass);
    if (family === undefined || current === undefined) return null;

    // Walk the ramp away from the current shade and take the first step that actually
    // clears the ratio — the smallest visible change that works, rather than the palette
    // entry nearest some ideal colour. Those differ more often than they sound: when the
    // required change is small, the nearest entry to the ideal is the shade we started
    // from, the verification fails, and a perfectly good one-step fix is never offered.
    const newRgb = parseColor(newHex);
    const currentRgb = parseColor(resolveTailwindColor(source.tailwindClass.replace(/^(?:text|bg|border)-/, '')) ?? '');
    const direction: 'darker' | 'lighter' =
      newRgb !== null && currentRgb !== null && relativeLuminance(newRgb) > relativeLuminance(currentRgb)
        ? 'lighter'
        : 'darker';

    for (const shade of rampFrom(family, current, direction)) {
      const newClass = source.tailwindClass.replace(/-\d{2,3}(\/\S+)?$/, `-${shade}$1`);
      const resolved = resolveTailwindColor(newClass.replace(/^(?:text|bg|border)-/, ''));
      const resolvedRgb = resolved !== undefined ? parseColor(resolved) : null;
      if (resolvedRgb === null) continue;
      // Offering a fix that does not fix is worse than offering none: the violation
      // looks handled and nobody checks it again.
      const achieved = verify(resolvedRgb);
      if (achieved < required) continue;

      const raw = wholeSource.slice(span.start, span.end);
      const swapped = raw.replace(
        new RegExp(`(^|[\\s"'\`])${escapeRegExp(source.tailwindClass)}(?=[\\s"'\`]|$)`),
        `$1${newClass}`,
      );
      if (swapped === raw) return null;
      return {
        edit: {
          start: span.start,
          end: span.end,
          replacement: swapped,
          label: `${label}: ${source.tailwindClass} -> ${newClass}`,
        },
        achieved,
      };
    }
    // No shade on the ramp works; the caller offers advice instead.
    return null;
  }

  const direct = parseColor(newHex);
  if (direct === null) return null;
  const achieved = verify(direct);
  // The same guard the Tailwind branch above applies, for the same reason: a fix that
  // does not fix is worse than no fix, because the violation looks handled and nobody
  // looks at it again. This branch used to trust the solver's own arithmetic; it had a
  // bug, and nothing downstream noticed.
  if (achieved < required) return null;
  // The label carries the swap for the same reason the Tailwind branch does: it is what
  // the diff header shows, and it is the one line a reader can check against their own
  // file in ten seconds. Without it every hex change in a report reads identically, and
  // eight identical paragraphs say less than eight different ones.
  const old = wholeSource.slice(span.start, span.end);
  return {
    edit: {
      start: span.start,
      end: span.end,
      replacement: newHex,
      label: old === '' ? label : `${label}: ${old} -> ${newHex}`,
    },
    achieved,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const textContrast: Rule = {
  id: 'A11Y-COLOR-001',
  title: 'Text contrast below the required ratio',
  wcag: ['1.4.3'],
  level: 'AA',
  severity: 'error',
  summary: 'Text whose colour and background do not meet the WCAG contrast minimum.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx): Violation[] {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (!hasOwnText(el)) continue;
      const pair = pairFor(el, ctx);
      if (pair === null) continue;

      const type = ctx.palette.typographyFor(el);
      const required = requiredRatio({
        level: ctx.level === 'AAA' ? 'AAA' : 'AA',
        fontSizePx: type.fontSizePx,
        bold: type.bold,
      });
      const bgOpaque = { ...pair.bgRgb, a: 1 };
      const fgFlat = flatten(pair.fgRgb, bgOpaque);
      const ratio = contrastRatio(fgFlat, bgOpaque);
      if (ratio >= required) continue;

      // When the text size is a guess, a 3:1 "large text" element could be misjudged as
      // failing 4.5:1. Only report those where it fails on either reading.
      if (!type.certain && ratio >= 3) continue;

      // A background inherited from a shared ancestor is very likely used by other
      // elements too, so only the foreground is safe to move.
      const bgIsShared = pair.bg.from !== el || pair.bg.provenance === 'default';
      const repair = repairPair(pair.fgRgb, bgOpaque, required, {
        ...(bgIsShared ? { lockBackground: true } : {}),
      });

      const where = pair.fg.provenance === 'inherited' ? ' (colour inherited from an ancestor)' : '';
      // Only mention the size assumption when it could have changed the verdict. Below
      // 3:1 the text fails at every threshold, so the caveat would be noise that trains
      // readers to skip the impact line.
      const sizeNote =
        type.certain || ratio < 3
          ? ''
          : ' Font size was not determinable here, so the 16px browser default was assumed.';

      /**
       * The ratio a candidate for the moving side would really render at.
       *
       * A Tailwind swap lands on a palette step and keeps the opacity modifier it found,
       * so the candidate can be translucent even when the colour the solver proved was
       * opaque. Two things then have to be true that are easy to get wrong: a candidate
       * *background* composites over the backdrop, not over the text sitting on it, and
       * a translucent foreground re-composites over the new background rather than
       * staying at the value it had over the old one. Verifying `bg-red-600/60` inside
       * `bg-white` against the text blended it with the text: 4.50:1 promised, 4.31:1
       * rendered, and the finding closed.
       */
      const backdrop = (pair.bg.behind !== undefined ? parseColor(pair.bg.behind) : null) ?? bgOpaque;
      const verify = (candidate: RGB): number => {
        if (repair?.moved === 'background') {
          const effective = flatten(candidate, backdrop);
          return contrastRatio(flatten(pair.fgRgb, effective), effective);
        }
        return contrastRatio(flatten(candidate, bgOpaque), bgOpaque);
      };

      let fix: Violation['fix'];
      if (repair !== null) {
        const target = repair.moved === 'foreground' ? pair.fg : pair.bg;
        const newHex = toHex(repair.color);
        const built = repair.disruptive
          ? null
          : buildEdit(target, newHex, verify, required, ctx.source, 'raise contrast');
        if (built !== null) {
          const edit = built.edit;
          // Describe the edit that will actually be written. When the patch swaps a
          // Tailwind shade, quoting a hex the developer will never see in their diff
          // makes the report look wrong even though the fix is right. Everywhere else
          // the hex is exactly what lands in the file, and naming which side moves is
          // what lets a reader — or a test — check the ratio for themselves.
          const swap =
            target.tailwindClass !== undefined ? /: (\S+) -> (\S+)$/.exec(edit.label) : null;
          fix = {
            safety: 'review',
            edits: [edit],
            description:
              swap !== null
                ? `Replace ${swap[1]} with ${swap[2]}, reaching ${built.achieved.toFixed(2)}:1.`
                : `Change the ${repair.moved} from ${toHex(repair.moved === 'foreground' ? pair.fgRgb : bgOpaque)} ` +
                  `to ${newHex}, reaching ${built.achieved.toFixed(2)}:1. Hue is preserved; only lightness moves.`,
          };
        } else {
          fix = {
            safety: 'manual',
            edits: [],
            description: 'Contrast can be reached, but not without a visible design change.',
            advisory:
              `The smallest change that reaches ${required}:1 moves the ${repair.moved} to ${newHex}. ` +
              (repair.disruptive
                ? 'That is a large enough shift to alter the design, so a person should choose it.'
                : 'The colour is not written in a form this tool can rewrite in place.'),
          };
        }
      } else {
        fix = {
          safety: 'manual',
          edits: [],
          description: 'No lightness adjustment of either colour reaches the required ratio.',
          advisory: `This pair cannot reach ${required}:1 by changing lightness alone. Pick a different colour.`,
        };
      }

      out.push(
        ctx.report({
          ruleId: textContrast.id,
          wcag: textContrast.wcag,
          level: 'AA',
          severity: 'error',
          start: el.openStart,
          end: el.openEnd,
          message:
            `Text contrast is ${ratio.toFixed(2)}:1, below the required ${required}:1 ` +
            `(${toHex(pair.fgRgb)} on ${toHex(bgOpaque)})${where}.`,
          impact:
            'People with low vision, colour vision deficiency, or anyone reading on a phone in ' +
            'sunlight cannot reliably make out this text.' + sizeNote,
          fix,
        }),
      );
    }
    return out;
  },
};

const nonTextContrast: Rule = {
  id: 'A11Y-COLOR-002',
  title: 'Interactive element border below 3:1',
  wcag: ['1.4.11'],
  level: 'AA',
  severity: 'warning',
  summary: 'Borders that identify a control must reach 3:1 against their surroundings.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx): Violation[] {
    const out: Violation[] = [];
    const INTERACTIVE = new Set(['input', 'select', 'textarea', 'button']);
    for (const el of ctx.markup.elements) {
      if (!INTERACTIVE.has(el.tagLower)) continue;
      const style = getAttr(el, 'style');
      if (style === undefined || style.dynamic || style.value === null) continue;
      const borderMatch = /border(?:-color)?\s*:\s*([^;]+)/i.exec(style.value);
      if (borderMatch === null) continue;
      const colourToken = (borderMatch[1] as string)
        .split(/\s+/)
        .find((p) => /^(#|rgb|hsl)/i.test(p) || parseColor(p) !== null);
      if (colourToken === undefined) continue;
      const border = parseColor(colourToken);
      const bg = ctx.palette.backgroundFor(el);
      if (border === null || bg === undefined) continue;
      const bgRgb = parseColor(bg.value);
      if (bgRgb === null) continue;

      const ratio = contrastRatio(flatten(border, { ...bgRgb, a: 1 }), { ...bgRgb, a: 1 });
      if (ratio >= 3) continue;

      out.push(
        ctx.report({
          ruleId: nonTextContrast.id,
          wcag: nonTextContrast.wcag,
          level: 'AA',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `Control border contrast is ${ratio.toFixed(2)}:1, below the required 3:1.`,
          impact:
            'The boundary of this control is invisible to some users, so they cannot tell where ' +
            'to click or that a form field is there at all.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Border colours often carry brand meaning; a person should pick the replacement.',
            advisory: 'Darken or lighten the border until it reaches 3:1 against the surrounding surface.',
          },
        }),
      );
    }
    return out;
  },
};

const linkColorOnly: Rule = {
  id: 'A11Y-COLOR-003',
  title: 'Link distinguished from body text by colour alone',
  wcag: ['1.4.1'],
  level: 'A',
  severity: 'warning',
  summary: 'Inline links need a non-colour cue, and 3:1 against the surrounding text.',
  appliesTo: ['html', 'jsx', 'vue', 'svelte'],
  run(ctx): Violation[] {
    const out: Violation[] = [];
    for (const el of ctx.markup.elements) {
      if (el.tagLower !== 'a') continue;
      if (textOf(el) === '') continue;
      // Only inline links inside a paragraph are at issue; a nav link surrounded by
      // other links has no body text to be confused with.
      const parent = el.parent;
      if (parent === null || !['p', 'li', 'span', 'td', 'dd'].includes(parent.tagLower)) continue;

      const classAttr = getAttr(el, 'class') ?? getAttr(el, 'className');
      const classes = classAttr?.value ?? '';
      const style = getAttr(el, 'style')?.value ?? '';
      // `no-underline` and `decoration-none` are underline *removals*, and the cue test
      // below is a substring match — "no-underline" contains "underline", and
      // "decoration-none" contains "decoration". Both therefore read as cues, the rule
      // skipped every element it exists to catch, and the Tailwind half of A11Y-COLOR-003
      // was unreachable code. Dropping the removal tokens first keeps a genuine cue
      // alongside one (`no-underline border-b-2`) working.
      const cueClasses = classes.replace(/\b(?:no-underline|decoration-none)\b/g, ' ');
      // An underline, a border, or a weight change all count as a non-colour cue.
      const hasNonColourCue =
        /underline|border-b|decoration|font-(bold|semibold|medium)/.test(cueClasses) ||
        /text-decoration\s*:\s*(?!none)/i.test(style) ||
        /border-bottom/i.test(style);
      if (hasNonColourCue) continue;
      // An explicit removal of the underline is the case worth flagging; a link with no
      // styling at all keeps the browser default underline and is fine.
      const removesUnderline =
        /no-underline|decoration-none/.test(classes) || /text-decoration\s*:\s*none/i.test(style);
      if (!removesUnderline) continue;

      const linkColor = ctx.palette.foregroundFor(el);
      const bodyColor = parent !== null ? ctx.palette.foregroundFor(parent) : undefined;
      let ratioNote = '';
      if (linkColor !== undefined && bodyColor !== undefined) {
        const a = parseColor(linkColor.value);
        const b = parseColor(bodyColor.value);
        if (a !== null && b !== null) {
          const ratio = contrastRatio({ ...a, a: 1 }, { ...b, a: 1 });
          if (ratio >= 3) continue;
          ratioNote = ` The link colour is only ${ratio.toFixed(2)}:1 against the surrounding text, below the 3:1 needed when colour is the only cue.`;
        }
      }

      out.push(
        ctx.report({
          ruleId: linkColorOnly.id,
          wcag: linkColorOnly.wcag,
          level: 'A',
          severity: 'warning',
          start: el.openStart,
          end: el.openEnd,
          message: `Inline link removes its underline and appears to rely on colour alone.${ratioNote}`,
          impact:
            'Readers who cannot distinguish the link colour from the body text — including most ' +
            'people with red-green colour blindness — cannot see that this text is a link.',
          fix: {
            safety: 'manual',
            edits: [],
            description: 'Restore an underline or add another non-colour cue.',
            advisory:
              'Remove the underline-suppressing class, or add a bottom border, so the link is ' +
              'identifiable without relying on colour.',
          },
        }),
      );
    }
    return out;
  },
};

export const RULES: readonly Rule[] = [textContrast, nonTextContrast, linkColorOnly];
