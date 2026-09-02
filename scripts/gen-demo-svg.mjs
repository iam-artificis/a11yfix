/**
 * Render a real run of the tool as an SVG, for the top of the README.
 *
 * Generated rather than drawn, for the same reason `docs/coverage.md` is: a picture of a
 * terminal is a claim about what the command prints, and a hand-made one starts drifting
 * the day after it is made. This runs the built CLI with FORCE_COLOR, reads the ANSI it
 * actually emits, and turns it into text — so the colours, the wrapping and every number
 * in the image are the command's, not a designer's.
 *
 * SVG rather than a GIF because it stays sharp, weighs a few kilobytes, is diffable in
 * review, and needs no recording tool in the dependency-free build this project keeps.
 *
 *   node scripts/gen-demo-svg.mjs        # writes docs/demo.svg
 *   node scripts/gen-demo-svg.mjs --check  # fails if the file is stale
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs', 'demo.svg');
// --quiet, because the image sits above the section that quotes the impact text in full.
// A picture that repeats the paragraph under it is padding.
const COMMAND = ['dist/cli.js', 'demo/Card.tsx', '--quiet'];

/** The palette the CLI writes, by SGR code. Dark terminal, deliberately: it is a terminal. */
const SGR = {
  0: null,
  1: { bold: true },
  2: { fill: '#8b949e' },
  31: { fill: '#ff7b72' },
  32: { fill: '#7ee787' },
  33: { fill: '#e3b341' },
  34: { fill: '#79c0ff' },
  90: { fill: '#6e7681' },
};

const BG = '#0d1117';
const FG = '#c9d1d9';
const PROMPT = '#7ee787';
const CHROME = '#161b22';
const FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const CHAR_W = 7.8;
const LINE_H = 19;
const PAD = 18;
const TOP = 44;
/** The output starts a line below the command, or the first row lands on the prompt. */
const BODY_TOP = TOP + LINE_H + 6;

/** Split one ANSI line into runs of text that share a style. */
function runs(line) {
  const out = [];
  let style = {};
  let text = '';
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    text += line.slice(last, m.index);
    if (text !== '') {
      out.push({ text, ...style });
      text = '';
    }
    for (const part of m[1].split(';')) {
      const code = Number(part === '' ? '0' : part);
      const s = SGR[code];
      style = s === null || s === undefined ? {} : { ...style, ...s };
    }
    last = re.lastIndex;
  }
  text += line.slice(last);
  if (text !== '') out.push({ text, ...style });
  return out;
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(lines) {
  const cols = Math.max(...lines.map((l) => stripped(l).length), 64);
  const width = Math.round(cols * CHAR_W + PAD * 2);
  const height = BODY_TOP + lines.length * LINE_H + PAD;
  const body = lines
    .map((line, i) => {
      const y = BODY_TOP + i * LINE_H;
      let x = PAD;
      const spans = runs(line)
        .map((r) => {
          const at = x;
          x += r.text.length * CHAR_W;
          if (r.text.trim() === '') return '';
          const fill = r.fill ?? FG;
          const weight = r.bold === true ? ' font-weight="600"' : '';
          return `<text x="${at.toFixed(1)}" y="${y}" fill="${fill}"${weight}>${esc(r.text)}</text>`;
        })
        .join('');
      return spans;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family='${FONT}' font-size="13">
<rect width="${width}" height="${height}" rx="8" fill="${BG}"/>
<rect width="${width}" height="30" rx="8" fill="${CHROME}"/>
<rect y="22" width="${width}" height="8" fill="${CHROME}"/>
<circle cx="18" cy="15" r="5" fill="#ff5f57"/><circle cx="36" cy="15" r="5" fill="#febc2e"/><circle cx="54" cy="15" r="5" fill="#28c840"/>
<text x="${PAD}" y="${TOP}" fill="${PROMPT}">$</text><text x="${PAD + CHAR_W * 2}" y="${TOP}" fill="${FG}">npx a11yfix demo/Card.tsx</text>
${body}
</svg>
`;
}

const stripped = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let raw;
try {
  raw = execFileSync(process.execPath, COMMAND, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
  });
} catch (err) {
  // Findings remain on the fixture, so the CLI exits 1. That is the expected result.
  raw = err.stdout ?? '';
}
if (raw.trim() === '') {
  console.error('the command produced nothing; run npm run build first');
  process.exit(1);
}

const lines = raw.replace(/\r\n/g, '\n').split('\n');
while (lines.length > 0 && lines[0].trim() === '') lines.shift();
while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

const svg = render(lines);

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== svg) {
    console.error('docs/demo.svg is stale — run: node scripts/gen-demo-svg.mjs');
    process.exit(1);
  }
  console.log('docs/demo.svg matches what the command prints');
} else {
  writeFileSync(OUT, svg, 'utf8');
  console.log(`docs/demo.svg written (${lines.length} lines, ${svg.length} bytes)`);
}
