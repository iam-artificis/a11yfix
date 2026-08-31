import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Level } from './types.js';

/**
 * Project configuration.
 *
 * A checker with no way to switch a rule off is a checker people delete. The specific
 * shape of that problem, measured: one rule accounted for 60% of the findings on a real
 * component library, and until this existed the only response available to its
 * maintainers would have been to stop running the tool.
 *
 * Deliberately small — a level, paths to skip, and rules to turn off. Every option here
 * exists because a real run produced a reason for it, and nothing is configurable that
 * would let the tool make a claim it could not otherwise make.
 */
export interface Config {
  readonly level?: Level;
  /** Glob patterns, relative to the config file, that are not analysed. */
  readonly ignore?: readonly string[];
  /** Rule ids mapped to "off", or to a severity that overrides the rule's own. */
  readonly rules?: Readonly<Record<string, 'off' | 'error' | 'warning' | 'info'>>;
}

export interface LoadedConfig extends Config {
  /** Where it came from, for the report. Absent when no file was found. */
  readonly source?: string;
}

const FILENAMES = ['.a11yfixrc.json', '.a11yfixrc'];

/**
 * Find and read the configuration for a directory.
 *
 * Walks upward so running the CLI inside `src/` picks up the project's config, and stops
 * at the first hit rather than merging several: a half-applied configuration is harder to
 * reason about than none.
 */
export async function loadConfig(from: string): Promise<LoadedConfig> {
  let dir = resolve(from);
  for (;;) {
    for (const name of FILENAMES) {
      const path = join(dir, name);
      const parsed = await readJson(path);
      if (parsed !== undefined) return { ...validate(parsed, path), source: path };
    }

    const pkgPath = join(dir, 'package.json');
    const pkg = await readJson(pkgPath);
    if (pkg !== undefined && typeof pkg === 'object' && pkg !== null && 'a11yfix' in pkg) {
      const section = (pkg as { a11yfix: unknown }).a11yfix;
      return { ...validate(section, pkgPath), source: `${pkgPath} (a11yfix)` };
    }

    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    // A malformed config is louder than a missing one on purpose: silently ignoring it
    // would leave a developer wondering why their ignore list does nothing.
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validate(value: unknown, path: string): Config {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  const raw = value as Record<string, unknown>;
  const out: {
    level?: Level;
    ignore?: string[];
    rules?: Record<string, 'off' | 'error' | 'warning' | 'info'>;
  } = {};

  if (raw['level'] !== undefined) {
    const level = raw['level'];
    if (level !== 'A' && level !== 'AA' && level !== 'AAA') {
      throw new Error(`${path}: level must be "A", "AA" or "AAA"`);
    }
    out.level = level;
  }

  if (raw['ignore'] !== undefined) {
    const ignore = raw['ignore'];
    if (!Array.isArray(ignore) || ignore.some((p) => typeof p !== 'string')) {
      throw new Error(`${path}: ignore must be an array of glob strings`);
    }
    out.ignore = ignore as string[];
  }

  if (raw['rules'] !== undefined) {
    const rules = raw['rules'];
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
      throw new Error(`${path}: rules must be an object mapping rule ids to a setting`);
    }
    const parsed: Record<string, 'off' | 'error' | 'warning' | 'info'> = {};
    for (const [id, setting] of Object.entries(rules as Record<string, unknown>)) {
      if (setting !== 'off' && setting !== 'error' && setting !== 'warning' && setting !== 'info') {
        throw new Error(
          `${path}: rules["${id}"] must be "off", "error", "warning" or "info" (got ${JSON.stringify(setting)})`,
        );
      }
      parsed[id] = setting;
    }
    out.rules = parsed;
  }

  return out;
}

/**
 * Match a path against a glob.
 *
 * Supports the subset people actually write in an ignore list: `*` for anything but a
 * separator, `**` for anything including separators, `?` for one character, and a
 * trailing `/` or a bare directory name to mean everything beneath it. Written by hand
 * because the alternative is a dependency, and this tool's claim to have none is worth
 * more than the last few percent of glob syntax.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const p = path.split(sep).join('/').replace(/^\.\//, '');
  let g = pattern
    .split(sep)
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '/**')
    // `**/` means "zero or more directories", so a run of them means what one means.
    // Compiled literally they became adjacent `(?:.*/)?` groups — the (a*)* shape —
    // and eight of them took five seconds to fail on an ordinary path. Ignore patterns
    // come out of a user's config file, so a plausible typo could hang a whole scan.
    .replace(/(?:\*\*\/)+/g, '**/')
    // Three or more stars is two stars with extra characters.
    .replace(/\*{3,}/g, '**');
  // A bare name with no wildcard and no slash means "this directory or file, anywhere".
  if (!g.includes('/') && !g.includes('*') && !g.includes('?')) g = `**/${g}/**`;

  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        // `**/` may match nothing at all, so `**/x` matches a bare `x`.
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`).test(p);
}

/** True when any pattern matches, with paths made relative to the config's directory. */
export function isIgnored(
  file: string,
  patterns: readonly string[],
  base: string,
): boolean {
  if (patterns.length === 0) return false;
  const rel = isAbsolute(file) ? relative(base, file) : file;
  const normalised = rel.split(sep).join('/');
  return patterns.some((p) => matchesGlob(normalised, p));
}
