import { readFile, writeFile } from 'node:fs/promises';
import type { Violation } from './types.js';

/**
 * Baselines: adopting the tool on a codebase that already has findings.
 *
 * This is the difference between a checker a team installs and one they read about. A
 * real application had 1381 findings on its first run. Nobody is going to fix 1381 things
 * before merging the next feature, so without a way to say "these are known, fail me only
 * on new ones" the entire tool is a report nobody opens.
 *
 * The design constraint that matters: a baseline must not go stale silently. Matching on
 * line numbers would mean any edit above a finding makes it look new, so people would
 * regenerate the baseline constantly and it would stop meaning anything. Matching on
 * nothing but the rule id would mean a fixed violation still counts as covered, so a
 * regression would hide behind its own ancestor. The fingerprint below sits in between:
 * rule, file, and the shape of the code — stable under reformatting and unrelated edits,
 * specific enough that a genuinely different violation is a new one.
 */

export interface BaselineFile {
  readonly version: 1;
  readonly created: string;
  readonly total: number;
  /** Fingerprint to the number of times it was seen. */
  readonly entries: Readonly<Record<string, number>>;
}

/**
 * Separator between the parts of a fingerprint.
 *
 * A unit separator rather than a space, because a file path may contain spaces and two
 * different findings must never collide into one key. Built with fromCodePoint rather
 * than typed as a literal: a raw control byte in a source file makes git treat it as
 * binary, breaks grep, and is invisible in every editor — which is exactly how it got
 * into this file the first time.
 */
const SEP = String.fromCodePoint(0x1f);

/**
 * A line-independent identity for a finding.
 *
 * The excerpt is normalised hard — whitespace collapsed, quote characters unified, spaces
 * removed where markup allows them freely — because the point is to survive a reformat,
 * not to be readable. Collapsing runs of whitespace is not enough on its own: a
 * prettier-style rewrite turns `<img src="a.png">` into a multi-line tag, and what
 * survives the collapse is `<img src="a.png" >`, one space away from a different key.
 */
export function fingerprint(v: Violation): string {
  const shape = v.excerpt
    .replace(/\s+/g, ' ')
    .replace(/['"]/g, '"')
    .replace(/\s*=\s*/g, '=')
    .replace(/\s+(\/?>)/g, '$1')
    .replace(/(<\/?)\s+/g, '$1')
    .trim()
    .slice(0, 120);
  return [v.ruleId, v.file, shape].join(SEP);
}

export function buildBaseline(violations: readonly Violation[], now: string): BaselineFile {
  const entries: Record<string, number> = {};
  for (const v of violations) {
    const key = fingerprint(v);
    entries[key] = (entries[key] ?? 0) + 1;
  }
  return { version: 1, created: now, total: violations.length, entries };
}

export async function writeBaseline(path: string, baseline: BaselineFile): Promise<void> {
  // Sorted keys so the file is diffable: a baseline nobody can read in review is a
  // blanket suppression with extra steps.
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(baseline.entries).sort()) {
    sorted[key] = baseline.entries[key] as number;
  }
  const out = { ...baseline, entries: sorted };
  await writeFile(path, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

export async function readBaseline(path: string): Promise<BaselineFile> {
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { entries?: unknown }).entries !== 'object'
  ) {
    throw new Error(`${path} is not an a11yfix baseline (expected version 1)`);
  }
  return parsed as BaselineFile;
}

export interface BaselineComparison {
  /** Findings not covered by the baseline — the ones CI should act on. */
  readonly fresh: Violation[];
  /** How many findings the baseline accounted for. */
  readonly matched: number;
  /**
   * Entries in the baseline that no longer occur. Not an error: it means somebody fixed
   * something, and the baseline can be shrunk.
   */
  readonly resolved: number;
}

/**
 * Split findings into those the baseline already knows about and those it does not.
 *
 * Counts matter. If a file had two of the same violation and now has three, the third is
 * new, and a set-based comparison would miss it.
 */
export function compareToBaseline(
  violations: readonly Violation[],
  baseline: BaselineFile,
): BaselineComparison {
  const remaining = new Map<string, number>(Object.entries(baseline.entries));
  const fresh: Violation[] = [];
  let matched = 0;

  for (const v of violations) {
    const key = fingerprint(v);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      matched++;
    } else {
      fresh.push(v);
    }
  }

  let resolved = 0;
  for (const left of remaining.values()) resolved += left;

  return { fresh, matched, resolved };
}
