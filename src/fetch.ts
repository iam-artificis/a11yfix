/**
 * Scanning a URL instead of a directory.
 *
 * The tool's premise is that it reads source rather than a rendered page, and this does
 * not change that: it reads the HTML the server sends, exactly as a browser first
 * receives it, and never runs a script. What it changes is who can ask a question.
 * "Send me your repository" excludes most of the people who need this most — a library, a
 * school, a museum whose site was built by an agency four years ago. "Send me your link"
 * excludes nobody.
 *
 * The honest limits are printed, not buried:
 *
 *  - No JavaScript runs. A client-rendered application serves an almost empty shell to
 *    anything that is not a browser, and the scan then finds nothing. That is not a clean
 *    result and must never be reported as one, so `sparse` says when it happened.
 *  - No patch. There is no file on disk to change, so --fix and --diff are refused rather
 *    than quietly producing a diff against a copy the client does not have.
 *  - One page. This is not a crawler. It fetches what the URL names and the stylesheets
 *    that page links from its own origin, and nothing else.
 */

import type { StylesheetSource } from './design/palette.js';
import { parseMarkup } from './parse/markup.js';

/** A page is not worth reading past this; a stylesheet even less so. */
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_SHEET_BYTES = 2 * 1024 * 1024;
const MAX_SHEETS = 24;
const TIMEOUT_MS = 20_000;

/**
 * Anything but a browser gets a shorter answer from some servers, and some refuse
 * outright. This is the identifying part of a current Chrome string: the aim is to be
 * served what a visitor is served, not to hide what is asking.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 a11yfix';

export interface FetchedPage {
  /** The URL after redirects — what was actually read. */
  readonly url: string;
  /** Display name for the scan, ending in .html so the engine treats it as markup. */
  readonly file: string;
  readonly html: string;
  readonly sheets: readonly StylesheetSource[];
  /**
   * True when the served HTML has almost no content, which on a live site nearly always
   * means the page is assembled by JavaScript in the browser.
   */
  readonly sparse: boolean;
  /** Things a person reading the result has to be told, in the order they happened. */
  readonly notes: readonly string[];
}

/** True for something the user typed meaning "go and read this", not "open this file". */
export function isUrl(arg: string): boolean {
  return /^https?:\/\//i.test(arg);
}

function readable(err: unknown): string {
  if (err instanceof Error) {
    // Node wraps the interesting part one level down more often than not.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== '') return cause.message;
    return err.message;
  }
  return String(err);
}

async function get(url: string, limit: number): Promise<{ body: string; final: string }> {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/css,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trimEnd());
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limit) {
    throw new Error(
      `${Math.round(buffer.byteLength / 1024)} KB exceeds the ${Math.round(limit / 1024)} KB limit`,
    );
  }
  // Servers still send windows-1251 in this corner of the web, and a page decoded as the
  // wrong encoding is worse than one not read at all: every rule that looks at text sees
  // mojibake and reports on it.
  const type = response.headers.get('content-type') ?? '';
  const declared = /charset=["']?([\w-]+)/i.exec(type)?.[1];
  let body = new TextDecoder(pickEncoding(declared), { fatal: false }).decode(buffer);
  if (declared === undefined) {
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.slice(0, 4096))?.[1];
    if (meta !== undefined && pickEncoding(meta) !== 'utf-8') {
      body = new TextDecoder(pickEncoding(meta), { fatal: false }).decode(buffer);
    }
  }
  return { body, final: response.url === '' ? url : response.url };
}

/** A label TextDecoder accepts, defaulting to UTF-8 for anything unrecognised. */
function pickEncoding(label: string | undefined): string {
  if (label === undefined) return 'utf-8';
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

/**
 * A scan name derived from the URL: `shm.ru/index.html`, `spbu.ru/about.html`.
 *
 * It has to end in `.html` for the engine to treat it as markup, and it has to be
 * recognisable in a report a client reads, which rules out both a temporary file name and
 * the raw URL with its query string.
 */
function scanName(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  const last = path.split('/').filter((s) => s !== '').pop();
  const base = last === undefined || last === '' ? 'index' : last.replace(/\.[^.]*$/, '');
  const dir = path.slice(0, path.length - (last?.length ?? 0)).replace(/^\/|\/$/g, '');
  const safe = (s: string): string => s.replace(/[^\w.\-/]+/g, '-');
  return `${url.host}/${dir === '' ? '' : `${safe(dir)}/`}${safe(base)}.html`;
}

/**
 * Read one page and the stylesheets it links from its own origin.
 *
 * Third-party sheets are skipped rather than fetched. The colour rules would be a little
 * better with them, and following links from a page into other people's servers is not
 * something a scan should start doing on its own; the count of what was skipped is
 * reported so the gap is visible rather than silent.
 */
export async function fetchPage(input: string): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https can be fetched, not ${url.protocol}`);
  }

  const notes: string[] = [];
  let page;
  try {
    page = await get(url.href, MAX_HTML_BYTES);
  } catch (err) {
    throw new Error(`Could not read ${url.href}: ${readable(err)}`);
  }
  const finalUrl = new URL(page.final);
  if (finalUrl.href !== url.href) notes.push(`redirected to ${finalUrl.href}`);

  const markup = parseMarkup(page.body);
  const sheets: StylesheetSource[] = [];
  let external = 0;
  let failed = 0;

  const hrefs: string[] = [];
  for (const el of markup.elements) {
    if (el.tagLower !== 'link') continue;
    const rel = el.attrs.find((a) => a.nameLower === 'rel')?.value?.toLowerCase() ?? '';
    if (!rel.split(/\s+/).includes('stylesheet')) continue;
    const href = el.attrs.find((a) => a.nameLower === 'href')?.value;
    if (href === undefined || href === null || href === '') continue;
    hrefs.push(href);
  }

  for (const href of hrefs) {
    if (sheets.length >= MAX_SHEETS) {
      notes.push(`stopped after ${MAX_SHEETS} stylesheets`);
      break;
    }
    let sheetUrl: URL;
    try {
      sheetUrl = new URL(href, finalUrl);
    } catch {
      continue;
    }
    if (sheetUrl.origin !== finalUrl.origin) {
      external++;
      continue;
    }
    try {
      const sheet = await get(sheetUrl.href, MAX_SHEET_BYTES);
      // No scope: a sheet the page itself links applies to that page, which is the whole
      // scan. Package scoping exists to stop one repository's fixture colouring another's
      // pages, and there are no packages here.
      sheets.push({ file: sheetUrl.pathname, content: sheet.body });
    } catch {
      failed++;
    }
  }
  if (external > 0) {
    notes.push(
      `${external} stylesheet${external === 1 ? '' : 's'} on another origin were not fetched, ` +
        'so some colours are unknown',
    );
  }
  if (failed > 0) notes.push(`${failed} stylesheet${failed === 1 ? '' : 's'} could not be read`);

  // A served page with almost no elements is a client-rendered application, and every
  // rule below will find nothing for a reason that has nothing to do with the site.
  const body = markup.elements.find((el) => el.tagLower === 'body');
  const inBody = body === undefined ? markup.elements.length : markup.elements.filter((el) => el.openStart > body.openStart).length;
  const sparse = inBody < 25;

  return {
    url: finalUrl.href,
    file: scanName(finalUrl),
    html: page.body,
    sheets,
    sparse,
    notes,
  };
}
