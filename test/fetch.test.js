import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fetchPage, isUrl } from '../dist/fetch.js';

/**
 * Reading a live URL is the mode that decides whether a stranger can ask a question at
 * all: "send me your repository" excludes a library whose site was built by an agency in
 * 2019, and "send me your link" excludes nobody.
 *
 * It is also the mode with the most ways to be quietly wrong, and every one of them ends
 * with a report that says less than the truth:
 *
 *  - a client-rendered shell scans clean because there was nothing in it;
 *  - a windows-1251 page decoded as UTF-8 turns every rule that reads text into a
 *    generator of nonsense findings;
 *  - a stylesheet that was not fetched leaves colours undetermined, silently.
 *
 * These are checked against a real server rather than a stub, because the interesting
 * failures are in headers and encodings, which a stub is exactly what would not have.
 */

const withServer = async (handler, fn) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
};

const PAGE = (body, head = '') =>
  `<!DOCTYPE html><html lang="ru"><head><title>Т</title>${head}</head><body>${body}</body></html>`;

const FULL_BODY = Array.from({ length: 40 }, (_, i) => `<p>строка ${i}</p>`).join('');

test('isUrl separates a link from a path', () => {
  assert.equal(isUrl('https://example.org/'), true);
  assert.equal(isUrl('http://example.org'), true);
  assert.equal(isUrl('HTTPS://EXAMPLE.ORG'), true);
  assert.equal(isUrl('./src'), false);
  assert.equal(isUrl('C:/Users/x/site.html'), false);
  assert.equal(isUrl('file:///etc/passwd'), false);
  // A Windows path is not a URL however much it looks like a scheme.
  assert.equal(isUrl('src/index.html'), false);
});

test('anything but http and https is refused', async () => {
  await assert.rejects(() => fetchPage('file:///etc/passwd'), /Only http and https/);
  await assert.rejects(() => fetchPage('not a url'), /Not a URL/);
});

test('a page is read and named after its URL', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE(FULL_BODY));
    },
    async (base) => {
      const page = await fetchPage(`${base}/about/contacts`);
      assert.match(page.file, /^127\.0\.0\.1:\d+\/about\/contacts\.html$/);
      assert.equal(page.sparse, false);
      assert.match(page.html, /строка 39/);
      assert.deepEqual([...page.notes], []);
    },
  );
});

test('a root URL is named index.html', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(FULL_BODY));
    },
    async (base) => {
      const page = await fetchPage(`${base}/`);
      assert.match(page.file, /\/index\.html$/);
    },
  );
});

test('an app shell is reported as sparse rather than as clean', async () => {
  // Verbatim shape of what msu.ru serves to anything that is not a browser: a SvelteKit
  // shell with the application in a script. Every rule finds nothing, and saying so
  // without saying why would be the single most misleading thing this tool could print.
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!DOCTYPE html><html lang="ru"><head><title>МГУ</title></head>' +
          '<body><div id="app"></div><script src="/_app/start.js"></script></body></html>',
      );
    },
    async (base) => {
      const page = await fetchPage(base);
      assert.equal(page.sparse, true);
    },
  );
});

test('windows-1251 is decoded as windows-1251', async () => {
  // Still in use across exactly the sites this mode exists for. Decoded as UTF-8 the
  // text becomes mojibake, and the rules that read text then report on the mojibake.
  const cyrillic = Buffer.from([0xd2, 0xe5, 0xea, 0xf1, 0xf2]); // «Текст» in cp1251
  const body = Buffer.concat([
    Buffer.from('<!DOCTYPE html><html lang="ru"><head><title>x</title></head><body><p>'),
    cyrillic,
    Buffer.from('</p>' + FULL_BODY + '</body></html>'),
  ]);
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1251' });
      res.end(body);
    },
    async (base) => {
      const page = await fetchPage(base);
      assert.match(page.html, /Текст/);
    },
  );
});

test('a charset declared only in a meta tag is honoured too', async () => {
  const cyrillic = Buffer.from([0xd2, 0xe5, 0xea, 0xf1, 0xf2]);
  const body = Buffer.concat([
    Buffer.from(
      '<!DOCTYPE html><html><head><meta charset="windows-1251"><title>x</title></head><body><p>',
    ),
    cyrillic,
    Buffer.from('</p>' + FULL_BODY + '</body></html>'),
  ]);
  await withServer(
    (req, res) => {
      // No charset in the header at all, which is the common case on old CMS installs.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    },
    async (base) => {
      const page = await fetchPage(base);
      assert.match(page.html, /Текст/);
    },
  );
});

test('same-origin stylesheets are fetched and foreign ones are counted, not followed', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/css/site.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('body { color: #999999; background: #ffffff; font-size: 16px }');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        PAGE(
          FULL_BODY,
          '<link rel="stylesheet" href="/css/site.css">' +
            '<link rel="stylesheet" href="https://cdn.example.org/lib.css">' +
            '<link rel="icon" href="/favicon.ico">',
        ),
      );
    },
    async (base) => {
      const page = await fetchPage(base);
      assert.equal(page.sheets.length, 1, 'only the same-origin sheet');
      assert.equal(page.sheets[0].file, '/css/site.css');
      assert.match(page.sheets[0].content, /#999999/);
      // The gap is stated. A colour the tool could not see is not a colour that passed.
      assert.equal(
        page.notes.some((n) => /another origin/.test(n)),
        true,
        `expected a note about the skipped sheet, got ${JSON.stringify(page.notes)}`,
      );
      // rel="icon" is not a stylesheet and must not be fetched as one.
      assert.equal(
        page.sheets.some((s) => s.file.includes('favicon')),
        false,
      );
    },
  );
});

test('a stylesheet that fails is counted rather than swallowed', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/gone.css') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(FULL_BODY, '<link rel="stylesheet" href="/gone.css">'));
    },
    async (base) => {
      const page = await fetchPage(base);
      assert.equal(page.sheets.length, 0);
      assert.equal(
        page.notes.some((n) => /could not be read/.test(n)),
        true,
      );
    },
  );
});

test('an HTTP error names the status rather than producing an empty scan', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('busy');
    },
    async (base) => {
      await assert.rejects(() => fetchPage(base), /Could not read .*503/);
    },
  );
});

test('a redirect is followed and said out loud', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/old') {
        res.writeHead(301, { location: '/new' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(FULL_BODY));
    },
    async (base) => {
      const page = await fetchPage(`${base}/old`);
      assert.match(page.url, /\/new$/);
      assert.equal(
        page.notes.some((n) => /redirected to/.test(n)),
        true,
      );
      assert.match(page.file, /\/new\.html$/);
    },
  );
});

/**
 * The refusals. Each one exists because the alternative is worse than an error message:
 * a diff against a file the client does not have, or a report whose subject is two
 * different things at once.
 */


const cli = (args) => {
  try {
    const stdout = execFileSync(process.execPath, ['dist/cli.js', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

test('a URL with --fix, --diff or --baseline-write is refused, not half-served', () => {
  for (const flag of ['--fix', '--diff', '--baseline-write']) {
    const r = cli(['https://example.invalid/', flag]);
    assert.equal(r.code, 2, `${flag} should exit 2`);
    assert.match(r.err, /no source file to change/);
    // It must fail before any request goes out: the refusal is about what the flag
    // means, not about whether the site answers.
    assert.doesNotMatch(r.err, /Could not read/);
  }
});

test('a URL and a path in one run is refused', () => {
  const r = cli(['https://example.invalid/', 'demo']);
  assert.equal(r.code, 2);
  assert.match(r.err, /not both in one run/);
});

test('an unreachable URL says so and exits 2', () => {
  // Port 1 refuses instantly. A .invalid hostname would work too but costs a DNS
  // timeout, and a suite nobody wants to wait for is a suite nobody runs.
  const r = cli(['http://127.0.0.1:1/']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Could not read http:\/\/127\.0\.0\.1:1\//);
});

test('the help documents the mode it now has', () => {
  const r = cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /a11yfix <url>/);
  assert.match(r.out, /SCANNING A LIVE PAGE/);
});
