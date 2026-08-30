import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Run the analysis and publish its shape as step outputs.
 *
 * Written against the raw runner contract rather than @actions/core so the action carries
 * the same promise the package does: no dependency tree arrives with it. The two things
 * that library gives you here are output escaping and command syntax, and both are a few
 * lines.
 */

const REPORT = join(process.env.RUNNER_TEMP ?? '.', 'a11yfix-report.json');

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const line = `${name}=${String(value)}\n`;
  if (file === undefined) {
    process.stdout.write(`::set-output name=${name}::${String(value)}\n`);
    return;
  }
  appendFileSync(file, line);
}

const version = process.env.A11YFIX_VERSION || 'latest';
const target = process.env.A11YFIX_PATH || '.';
const level = process.env.A11YFIX_LEVEL || 'AA';

// A repository that already depends on the package — or a test of this action — runs the
// local binary instead of fetching one. Without this the action can only ever be
// exercised against a published version, which is a poor way to find out it is broken.
const local = process.env.A11YFIX_BIN;
const command = local === undefined ? ['npx', ['--yes', `a11yfix@${version}`]] : [process.execPath, [local]];

let json = '';
try {
  json = execFileSync(
    command[0],
    [...command[1], target, '--json', '--level', level],
    // npx is a shell script on Windows and needs one; node is an executable and must not
    // get one, or a space in its path (C:\Program Files) is read as an argument break.
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: local === undefined && process.platform === 'win32' },
  );
} catch (err) {
  // A non-zero exit is how the CLI reports "errors remain", not how it reports failure,
  // so the report on stdout is still the thing we want.
  json = String(err.stdout ?? '');
  if (json.trim() === '') {
    console.log(`::error::a11yfix could not run: ${String(err.stderr ?? err.message).slice(0, 500)}`);
    process.exit(1);
  }
}

let summary;
try {
  summary = JSON.parse(json);
} catch {
  console.log('::error::a11yfix produced output that is not valid JSON.');
  process.exit(1);
}

writeFileSync(REPORT, json);

const t = summary.totals ?? {};
setOutput('errors', t.errors ?? 0);
setOutput('warnings', t.warnings ?? 0);
setOutput('fixable', (t.automatic ?? 0) + (t.review ?? 0));
setOutput('report', REPORT);

// The job summary is the one place a reader looks before they look anywhere else.
const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary !== undefined) {
  const lines = [
    '## A11yFix',
    '',
    `**${t.violations ?? 0} findings** — ${t.errors ?? 0} errors, ${t.warnings ?? 0} warnings.`,
    `${(t.automatic ?? 0) + (t.review ?? 0)} have a patch; ${t.manual ?? 0} need a person.`,
    '',
  ];
  const byRule = summary.byRule ?? [];
  if (byRule.length > 0) {
    lines.push('| Rule | Count |', '|---|---|');
    for (const r of byRule.slice(0, 10)) lines.push(`| \`${r.ruleId}\` | ${r.count} |`);
    lines.push('');
  }
  lines.push(
    '_Automated checks reach a minority of WCAG success criteria. A clean run is not a',
    'conformance claim._',
    '',
  );
  appendFileSync(stepSummary, lines.join('\n'));
}

console.log(
  `a11yfix: ${t.violations ?? 0} findings (${t.errors ?? 0} errors, ${t.warnings ?? 0} warnings)`,
);
