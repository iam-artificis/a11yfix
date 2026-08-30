import type { Rule } from '../types.js';
import { RULES as aria } from './aria.js';
import { RULES as contrast } from './contrast.js';
import { RULES as forms } from './forms.js';
import { RULES as images } from './images.js';
import { RULES as keyboard } from './keyboard.js';
import { RULES as links } from './links.js';
import { RULES as structure } from './structure.js';
import { TODO_RULES as todo } from './todo.js';

/**
 * The rule registry.
 *
 * Families are listed explicitly rather than discovered from the filesystem, so that a
 * broken family is a compile error rather than a silently smaller rule set. A checker
 * that quietly stops checking things is the worst kind of broken.
 */
export const ALL_RULES: readonly Rule[] = [
  ...images,
  ...forms,
  ...structure,
  ...keyboard,
  ...aria,
  ...links,
  ...contrast,
  ...todo,
];
