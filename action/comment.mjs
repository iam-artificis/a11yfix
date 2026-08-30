import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Post the findings as a single pull-request comment, updated in place on every run.
 *
 * Updating rather than appending is the whole design. A bot that adds a new comment per
 * push turns a five-commit pull request into five walls of the same text, and the first
 * thing a team does about that is mute the bot — which costs them the findings they
 * actually wanted.
 */

const MARKER = '<!-- a11yfix-report -->';
const MAX_ROWS = 40;

const report = JSON.parse(readFileSync(process.env.A11YFIX_REPORT, 'utf8'));
const repo = process.env.A11YFIX_REPO;
const pr = process.env.A11YFIX_PR;
if (repo === undefined || pr === undefined) {
  console.log('a11yfix: not a pull request, nothing to comment on.');
  process.exit(0);
}

const gh = (args, input) =>
  execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });

const t = report.totals ?? {};
const files = report.files ?? [];
const all = files.flatMap((f) => (f.violations ?? []).map((v) => ({ ...v, file: f.file })));
const errors = all.filter((v) => v.severity === 'error');
const shown = [...errors, ...all.filter((v) => v.severity !== 'error')].slice(0, MAX_ROWS);

const body = [MARKER, '## A11yFix', ''];

if (all.length === 0) {
  body.push('No findings in the checks this tool can perform.');
} else {
  body.push(
    `**${all.length} findings** — ${t.errors ?? 0} errors, ${t.warnings ?? 0} warnings, ` +
      `across ${files.filter((f) => (f.violations ?? []).length > 0).length} files.`,
    `${(t.automatic ?? 0) + (t.review ?? 0)} have a patch you can apply with ` +
      '`npx a11yfix . --fix --include-review`.',
    '',
    '| | Where | What | Rule |',
    '|---|---|---|---|',
  );
  for (const v of shown) {
    const icon = v.severity === 'error' ? '🔴' : '🟡';
    const where = `\`${v.file}:${v.line}\``;
    const what = String(v.message).replace(/\|/g, '\\|');
    body.push(`| ${icon} | ${where} | ${what} | \`${v.ruleId}\` |`);
  }
  if (all.length > shown.length) {
    body.push('', `_…and ${all.length - shown.length} more. Run \`npx a11yfix .\` locally for the full list._`);
  }
}

body.push(
  '',
  '<sub>Automated checks reach a minority of WCAG success criteria. A clean run is not a ',
  'conformance claim: keyboard flows, focus order, meaningful alternative text and actual ',
  'screen-reader behaviour still need a person.</sub>',
);

const text = body.join('\n');

// Find an existing comment of ours so the thread stays one comment long.
let existing;
try {
  const listed = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate']));
  existing = listed.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
} catch (err) {
  console.log(`::warning::could not list existing comments: ${String(err.message).slice(0, 200)}`);
}

const payload = join(process.env.RUNNER_TEMP ?? '.', 'a11yfix-comment.json');
writeFileSync(payload, JSON.stringify({ body: text }));

try {
  if (existing !== undefined) {
    gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', payload]);
    console.log('a11yfix: updated the existing comment.');
  } else {
    gh(['api', '--method', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', payload]);
    console.log('a11yfix: posted a comment.');
  }
} catch (err) {
  // A fork pull request has a read-only token. That is a permissions fact, not a build
  // failure, and failing here would make the action unusable on any repository that
  // accepts outside contributions.
  console.log(`::warning::could not post the comment: ${String(err.message).slice(0, 300)}`);
  console.log(text);
}
