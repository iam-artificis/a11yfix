import type { Edit, Fix, FixSafety, Violation } from '../types.js';

/**
 * Applying edits and rendering diffs.
 *
 * Two invariants make this safe to point at someone's repository:
 *
 * 1. Edits are applied right-to-left, so earlier offsets stay valid as later text is
 *    replaced. Applying left-to-right and adjusting offsets afterwards is the classic
 *    way codemods corrupt files, and the corruption is silent.
 * 2. Overlapping edits are refused, not merged. Two rules that both want to rewrite the
 *    same attribute disagree about the answer, and picking one arbitrarily produces a
 *    result neither rule intended.
 */

export interface ApplyResult {
  readonly output: string;
  readonly applied: readonly Edit[];
  /** Edits dropped because they overlapped an already-applied edit. */
  readonly conflicted: readonly Edit[];
}

const SAFETY_ORDER: Readonly<Record<FixSafety, number>> = {
  automatic: 0,
  review: 1,
  manual: 2,
};

/** True when a fix is allowed under the run's threshold. */
export function fixAllowed(fix: Fix, threshold: FixSafety): boolean {
  if (fix.advisory !== undefined) return false;
  if (fix.edits.length === 0) return false;
  return SAFETY_ORDER[fix.safety] <= SAFETY_ORDER[threshold];
}

/** Apply a set of edits to a source string. */
export function applyEdits(source: string, edits: readonly Edit[]): ApplyResult {
  const sorted = [...edits].sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));

  const accepted: Edit[] = [];
  const conflicted: Edit[] = [];
  let lastEnd = -1;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
      conflicted.push(edit);
      continue;
    }
    if (edit.start < lastEnd) {
      conflicted.push(edit);
      continue;
    }
    accepted.push(edit);
    lastEnd = edit.end;
  }

  let output = source;
  for (let i = accepted.length - 1; i >= 0; i--) {
    const e = accepted[i] as Edit;
    output = output.slice(0, e.start) + e.replacement + output.slice(e.end);
  }

  return { output, applied: accepted, conflicted };
}

/** Collect the edits from the violations whose fixes clear the threshold. */
export function selectEdits(
  violations: readonly Violation[],
  threshold: FixSafety,
): { edits: Edit[]; applied: number; skipped: number } {
  const edits: Edit[] = [];
  let applied = 0;
  let skipped = 0;
  for (const v of violations) {
    if (v.fix === undefined) continue;
    if (fixAllowed(v.fix, threshold)) {
      edits.push(...v.fix.edits);
      applied++;
    } else {
      skipped++;
    }
  }
  return { edits, applied, skipped };
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

interface Hunk {
  aStart: number;
  aLines: string[];
  bStart: number;
  bLines: string[];
}

/**
 * Longest common subsequence over lines, used to produce a minimal diff.
 *
 * Falls back to a whole-file replacement above a size limit: the quadratic table is
 * fine for the files this tool edits (components, templates, stylesheets) but would
 * be a denial-of-service on a bundled or generated file that slipped through a glob.
 */
function lcsMatrix(a: readonly string[], b: readonly string[]): Uint32Array | null {
  if (a.length * b.length > 4_000_000) return null;
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? (table[(i + 1) * w + j + 1] as number) + 1
          : Math.max(table[(i + 1) * w + j] as number, table[i * w + j + 1] as number);
    }
  }
  return table;
}

export type Op = { readonly kind: ' ' | '-' | '+'; readonly text: string };

export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  const table = lcsMatrix(a, b);
  if (table === null) {
    return [...a.map((t) => ({ kind: '-' as const, text: t })), ...b.map((t) => ({ kind: '+' as const, text: t }))];
  }
  const w = b.length + 1;
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * w + j] as number) >= (table[i * w + j + 1] as number)) {
      ops.push({ kind: '-', text: a[i] as string });
      i++;
    } else {
      ops.push({ kind: '+', text: b[j] as string });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: '-', text: a[i++] as string });
  while (j < b.length) ops.push({ kind: '+', text: b[j++] as string });
  return ops;
}

/**
 * Render a unified diff. Returns an empty string when the sources are identical.
 *
 * Hunks are built from a single op stream rather than two parallel line lists. The
 * two-list version is the obvious design and it is subtly wrong: it loses the relative
 * order of a deletion and the insertion that replaces it, so the diff stops applying
 * cleanly with `git apply` exactly when the change is most interesting.
 */
export function unifiedDiff(
  filePath: string,
  before: string,
  after: string,
  context = 3,
): string {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a.lines, b.lines);

  // Index every op that represents a change, then merge changes that sit close enough
  // together to share surrounding context.
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if ((ops[i] as Op).kind !== ' ') changed.push(i);
  // A file whose only change is gaining or losing its trailing newline has no changed
  // lines at all, but it did change. Anchoring a group on the last line makes the
  // delete/add pair below fire, which is exactly how git represents it.
  if (changed.length === 0) {
    if (a.hasFinalNewline === b.hasFinalNewline || ops.length === 0) return '';
    changed.push(ops.length - 1);
  }

  const groups: { from: number; to: number }[] = [];
  let from = changed[0] as number;
  let to = from;
  for (const idx of changed.slice(1)) {
    if (idx - to <= context * 2) {
      to = idx;
    } else {
      groups.push({ from, to });
      from = idx;
      to = idx;
    }
  }
  groups.push({ from, to });

  // Running line numbers so each hunk header reports the right starting lines.
  const aLineAt: number[] = new Array(ops.length + 1);
  const bLineAt: number[] = new Array(ops.length + 1);
  let aNo = 1;
  let bNo = 1;
  for (let i = 0; i < ops.length; i++) {
    aLineAt[i] = aNo;
    bLineAt[i] = bNo;
    const k = (ops[i] as Op).kind;
    if (k === ' ' || k === '-') aNo++;
    if (k === ' ' || k === '+') bNo++;
  }
  aLineAt[ops.length] = aNo;
  bLineAt[ops.length] = bNo;

  // Index of the op carrying each side's final line, so the missing-newline marker
  // lands in exactly the right place.
  let lastA = -1;
  let lastB = -1;
  for (let i = 0; i < ops.length; i++) {
    const k = (ops[i] as Op).kind;
    if (k !== '+') lastA = i;
    if (k !== '-') lastB = i;
  }

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const g of groups) {
    const start = Math.max(0, g.from - context);
    const end = Math.min(ops.length, g.to + context + 1);
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    out.push(
      `@@ -${aCount === 0 ? 0 : (aLineAt[start] as number)},${aCount} ` +
        `+${bCount === 0 ? 0 : (bLineAt[start] as number)},${bCount} @@`,
    );
    for (let i = start; i < end; i++) {
      const op = ops[i] as Op;
      // A shared context line cannot carry two different newline states. When the two
      // sides disagree, git itself rewrites it as a delete/add pair, and a patch that
      // does not do the same is rejected by `git apply`.
      if (op.kind === ' ' && i === lastA && i === lastB && a.hasFinalNewline !== b.hasFinalNewline) {
        out.push('-' + op.text);
        if (!a.hasFinalNewline) out.push(NO_NEWLINE);
        out.push('+' + op.text);
        if (!b.hasFinalNewline) out.push(NO_NEWLINE);
        continue;
      }
      out.push(op.kind + op.text);
      const endsA = i === lastA && op.kind !== '+' && !a.hasFinalNewline;
      const endsB = i === lastB && op.kind !== '-' && !b.hasFinalNewline;
      if (endsA || endsB) out.push(NO_NEWLINE);
    }
  }
  return out.join('\n') + '\n';
}

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * Split into lines without inventing a trailing empty one.
 *
 * `"a\nb\n".split("\n")` yields three elements, the last empty. Treating that phantom
 * as a line makes every diff of a normally-terminated file one line too long, and the
 * resulting hunk headers do not match what git counts.
 */
function splitLines(text: string): { lines: string[]; hasFinalNewline: boolean } {
  const hasFinalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasFinalNewline) lines.pop();
  return { lines, hasFinalNewline };
}
