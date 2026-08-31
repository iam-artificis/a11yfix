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
import { gunzipSync } from 'node:zlib';
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

async function get(
  url: string,
  limit: number,
): Promise<{ body: string; bytes: Uint8Array; final: string; type: string }> {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/css,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trimEnd());
  }
  // Checked before reading, when the server says so, and again after: Content-Length is
  // advisory and a chunked response has none, but when it is there it saves pulling a
  // gigabyte into memory to then decide against it.
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  const tooBig = (bytes: number): Error =>
    new Error(`${Math.round(bytes / 1024)} KB exceeds the ${Math.round(limit / 1024)} KB limit`);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw tooBig(declaredLength);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limit) throw tooBig(buffer.byteLength);
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
  return {
    body,
    bytes: new Uint8Array(buffer),
    final: response.url === '' ? url : response.url,
    type,
  };
}

/** Content types worth handing to a markup parser. An absent type is not a refusal. */
const HTMLISH = /^(?:text\/html|application\/xhtml)/i;

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
  if (page.type !== '' && !HTMLISH.test(page.type)) {
    // A sitemap happily lists PDFs and images alongside pages. Parsing one as markup
    // produces findings about bytes that were never HTML, which is worse than skipping.
    throw new Error(`${url.href} is ${page.type.split(';')[0] as string}, not an HTML page`);
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

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

/**
 * A sitemap index may name dozens of sitemaps. Reading them all to satisfy a scan of
 * fifty pages would be work nobody asked for, on somebody else's server.
 */
const MAX_CHILD_SITEMAPS = 10;

/** `<loc>` holds a URL and nothing else, so this needs no XML parser. */
const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

/**
 * Sitemaps list documents, not only pages: nlr.ru's names PDFs among its articles.
 * Dropped by extension before anything is requested, so a scan of fifty pages does not
 * spend ten of them downloading files it cannot read.
 */
const NOT_A_PAGE =
  /\.(?:pdf|docx?|xlsx?|pptx?|rtf|odt|ods|zip|rar|7z|gz|tar|csv|txt|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp3|mp4|avi|mov|wmv|webm|ogg|wav|woff2?|ttf|eot|apk|exe|dmg|xml|json)$/i;

export interface SitemapResult {
  readonly urls: readonly string[];
  readonly notes: readonly string[];
  /** How many pages the sitemap offered, before the cap. */
  readonly listed: number;
}

/**
 * How many candidates to gather before choosing which to read.
 *
 * A sitemap is written in whatever order the CMS emitted it, which on Bitrix means the
 * oldest section first. Taking the first fifty of four thousand gave a scan of one
 * section — on shm.ru literally `1script.php`, `script.php` and `test.php` — and called
 * it an audit of the site. Gathering a pool and stepping through it evenly costs a few
 * more requests for the sitemap files themselves and produces a sample that is actually
 * about the site.
 */
const POOL_FACTOR = 20;

/**
 * Pick `limit` items spread evenly across `pool`, keeping its order.
 *
 * Both ends are included, so the sample reaches the sections a CMS puts last as well as
 * the ones it puts first.
 */
export function spread(pool: readonly string[], limit: number): string[] {
  if (limit <= 0) return [];
  if (pool.length <= limit) return [...pool];
  if (limit === 1) return [pool[0] as string];
  const chosen = new Set<number>();
  for (let i = 0; i < limit; i++) {
    chosen.add(Math.round((i * (pool.length - 1)) / (limit - 1)));
  }
  // Rounding can land twice on one index. Top up from whatever is still unused rather
  // than returning fewer pages than were asked for.
  for (let i = 0; chosen.size < limit && i < pool.length; i++) chosen.add(i);
  return [...chosen].sort((a, b) => a - b).map((i) => pool[i] as string);
}

function gunzipIfNeeded(bytes: Uint8Array, text: string): string {
  // The gzip magic number. Servers serve sitemap.xml.gz with every content-type there
  // is, so the bytes are more reliable than the header.
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return text;
  return new TextDecoder('utf-8', { fatal: false }).decode(gunzipSync(bytes));
}

/**
 * The pages a site lists for machines to read.
 *
 * This exists instead of a crawler. A crawler has to decide what counts as a page, how
 * deep to go, and how hard to push somebody's server; a sitemap is the site's own answer
 * to the first two and lets the third stay conservative. Institutional sites in this
 * market — Bitrix, 1C, uCoz — publish one nearly without exception.
 *
 * Same-origin only, deduplicated, and capped by the caller. A sitemap index is followed
 * one level down and no further.
 */
export async function fetchSitemap(input: string, limit: number): Promise<SitemapResult> {
  let root: URL;
  try {
    root = new URL(input);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') {
    throw new Error(`Only http and https can be fetched, not ${root.protocol}`);
  }

  const notes: string[] = [];
  const read = async (url: string): Promise<string> => {
    const got = await get(url, MAX_HTML_BYTES);
    return gunzipIfNeeded(got.bytes, got.body);
  };

  let xml: string;
  try {
    xml = await read(root.href);
  } catch (err) {
    throw new Error(`Could not read ${root.href}: ${readable(err)}`);
  }

  // `<loc>` is XML, so `?a=1&b=2` is written `?a=1&amp;b=2`. Fetching it verbatim asks
  // the server for a query string that has "amp;" in the middle of it.
  const unescapeXml = (s: string): string =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  const locs = (text: string): string[] =>
    [...text.matchAll(LOC)].map((m) => unescapeXml(m[1] as string));
  const isIndex = /<sitemapindex[\s>]/i.test(xml);

  const seen = new Set<string>();
  const pool: string[] = [];
  const take = (raw: string): void => {
    let u: URL;
    try {
      u = new URL(raw, root);
    } catch {
      return;
    }
    if (u.origin !== root.origin) return;
    if (NOT_A_PAGE.test(u.pathname)) return;
    u.hash = '';
    if (seen.has(u.href)) return;
    seen.add(u.href);
    pool.push(u.href);
  };
  const poolTarget = Math.max(limit * POOL_FACTOR, limit);

  if (isIndex) {
    const children = locs(xml);
    if (children.length > MAX_CHILD_SITEMAPS) {
      notes.push(
        `sitemap index lists ${children.length} sitemaps; read the first ${MAX_CHILD_SITEMAPS}`,
      );
    }
    let failed = 0;
    for (const child of children.slice(0, MAX_CHILD_SITEMAPS)) {
      if (pool.length >= poolTarget) break;
      try {
        for (const loc of locs(await read(new URL(child, root).href))) take(loc);
      } catch {
        failed++;
      }
    }
    if (failed > 0) notes.push(`${failed} of the listed sitemaps could not be read`);
  } else {
    for (const loc of locs(xml)) take(loc);
  }

  if (pool.length === 0) {
    throw new Error(
      `${root.href} lists no pages. It may not be a sitemap, or every URL in it is on another host.`,
    );
  }

  // The front page is the one everybody judges the site by, and an even stride can step
  // straight past it — or the sitemap can omit it, as shm.ru's does. Either way it is
  // read: an audit of a site that skipped its own front door is a bad audit, and one
  // request is not a cost worth weighing against that. When it is missing from the list,
  // a slot is reserved for it rather than taken from the sample after the fact.
  const home = `${root.origin}/`;
  const addHome = limit > 1 && !seen.has(home);
  const urls = spread(pool, addHome ? limit - 1 : limit);
  if (limit > 1 && !urls.includes(home)) {
    if (addHome) {
      urls.unshift(home);
      notes.push('the sitemap does not list the front page; read anyway');
    } else {
      // Listed, but the stride landed either side of it. One sampled page gives way.
      urls.splice(0, 1, home);
    }
  }
  if (pool.length > urls.length) {
    notes.push(
      `sitemap lists ${pool.length} pages; reading ${urls.length}, spread evenly across the list`,
    );
  }
  return { urls, notes, listed: pool.length };
}
