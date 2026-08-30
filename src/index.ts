/**
 * The programmatic surface of A11yFix.
 *
 * Kept deliberately small. Everything exported here is something a caller can build on:
 * run the analysis, read the findings, turn them into a patch. Internals stay internal so
 * they can be rewritten without breaking anyone.
 */

export { analyseSource, analyseFiles, kindOf, VERSION } from './engine.js';
export type { AnalyseOptions } from './engine.js';

export { ALL_RULES } from './rules/index.js';

export { loadConfig, matchesGlob, isIgnored } from './config.js';
export { findSuppressions, applySuppressions } from './suppress.js';
export type { Suppression } from './suppress.js';
export type { Config, LoadedConfig } from './config.js';

export { applyEdits, selectEdits, unifiedDiff, fixAllowed } from './fix/apply.js';
export type { ApplyResult } from './fix/apply.js';

export {
  parseColor,
  contrastRatio,
  requiredRatio,
  repairContrast,
  repairPair,
  flatten,
  toHex,
  rgbToOklch,
  oklchToRgb,
} from './color.js';
export type { RGB, OKLCH, ContrastRepair, PairRepair } from './color.js';

export { parseMarkup, getAttr, hasAttr, textOf, positionAt } from './parse/markup.js';
export type { Element, Attr, ParsedMarkup, QuoteKind } from './parse/markup.js';

export { Palette } from './design/palette.js';
export type { StylesheetSource } from './design/palette.js';

export type {
  Edit,
  FileKind,
  FileResult,
  Fix,
  FixSafety,
  Level,
  Rule,
  RuleContext,
  RunSummary,
  Severity,
  Violation,
} from './types.js';
export { TODO_MARKER } from './types.js';
