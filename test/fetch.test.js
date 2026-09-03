import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import {
  fetchPage,
  fetchSitemap,
  isUrl,
  spread,
  isIncompleteChain,
  caIssuersFrom,
  isSelfSigned,
  signedByKnownRoot,
  isPrivateIp,
  resolvesPrivate,
  refuseCrossingInward,
} from '../dist/fetch.js';

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


/**
 * The CLI as a child process, without blocking this one.
 *
 * execFileSync stops this process's event loop, so a test server running here cannot
 * answer the child and every request times out. Any test that points the CLI at
 * withServer has to await instead.
 */
const cliAsync = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' }, (err, out, e) =>
      resolve({ code: err?.code ?? 0, out: out ?? '', err: e ?? '' }),
    );
  });

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

test('an oversized response is refused on the declared length, not after reading it', async () => {
  await withServer(
    (req, res) => {
      // Lies about the size in the only way that matters here: says it is enormous and
      // then serves nothing. If the limit were only checked after reading, this would
      // pass — which is exactly the case where reading first is expensive.
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '900000000' });
      res.end();
    },
    async (base) => {
      await assert.rejects(() => fetchPage(base), /exceeds the .* limit/);
    },
  );
});


/**
 * Which pages a site audit reads.
 *
 * A sitemap comes out in whatever order the CMS emitted it, and on the sites this tool is
 * aimed at that is oldest-section-first. Reading the first fifty of four thousand gave an
 * audit of one section: on shm.ru the first twelve entries include `1script.php`,
 * `script.php` and `test.php`, three of which serve nothing a visitor ever sees. A
 * stride across the whole list costs the same fifty requests and describes the site.
 */

const sitemapOf = (urls) =>
  '<?xml version="1.0" encoding="UTF-8"?><urlset>' +
  urls.map((u) => `<url><loc>${u}</loc></url>`).join('') +
  '</urlset>';

test('spread reaches both ends of the list, not just the front of it', () => {
  const pool = Array.from({ length: 100 }, (_, i) => `p${i}`);
  const picked = spread(pool, 5);
  assert.equal(picked.length, 5);
  assert.equal(picked[0], 'p0');
  assert.equal(picked[4], 'p99', 'the last section of a sitemap is part of the site');
  assert.deepEqual(picked, ['p0', 'p25', 'p50', 'p74', 'p99']);
});

test('spread returns the number of pages it was asked for, even when rounding collides', () => {
  // A pool barely larger than the limit makes the stride about 1, where naive rounding
  // lands on the same index twice and silently returns a shorter audit than was paid for.
  for (const n of [51, 52, 53, 60, 99]) {
    const pool = Array.from({ length: n }, (_, i) => `p${i}`);
    const picked = spread(pool, 50);
    assert.equal(picked.length, 50, `pool of ${n}`);
    assert.equal(new Set(picked).size, 50, `pool of ${n}: no page read twice`);
  }
});

test('spread leaves a list shorter than the limit alone', () => {
  assert.deepEqual(spread(['a', 'b'], 50), ['a', 'b']);
  assert.deepEqual(spread([], 50), []);
  assert.deepEqual(spread(['a', 'b', 'c'], 1), ['a']);
});

test('a sitemap is sampled across the whole site and says so', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/sitemap.xml') {
        const urls = ['/', ...Array.from({ length: 199 }, (_, i) => `/page-${i}/`)];
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(sitemapOf(urls.map((u) => `http://127.0.0.1:${res.socket.localPort}${u}`)));
        return;
      }
      res.writeHead(404).end();
    },
    async (base) => {
      const r = await fetchSitemap(`${base}/sitemap.xml`, 10);
      assert.equal(r.urls.length, 10);
      assert.equal(r.listed, 200);
      assert.ok(r.urls.includes(`${base}/`), 'the front page is read');
      assert.ok(
        r.urls.some((u) => u.includes('page-198')),
        'and so is the far end of the list',
      );
      assert.ok(
        r.notes.some((n) => n.includes('200') && n.includes('spread evenly')),
        'the sampling is stated, not silent: ' + JSON.stringify(r.notes),
      );
    },
  );
});

test('a sitemap smaller than the cap is read whole, and the front page is added to it', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        sitemapOf([
          `http://127.0.0.1:${res.socket.localPort}/a/`,
          `http://127.0.0.1:${res.socket.localPort}/b/`,
        ]),
      );
    },
    async (base) => {
      const r = await fetchSitemap(`${base}/sitemap.xml`, 50);
      assert.deepEqual(r.urls, [`${base}/`, `${base}/a/`, `${base}/b/`]);
      assert.equal(r.listed, 2, 'the added front page is not counted as something listed');
      assert.deepEqual(r.notes, ['the sitemap does not list the front page; read anyway']);
    },
  );
});

test('a sitemap index is followed, and the sample spans its children', async () => {
  await withServer(
    (req, res) => {
      const origin = `http://127.0.0.1:${res.socket.localPort}`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      if (req.url === '/sitemap.xml') {
        res.end(
          '<?xml version="1.0"?><sitemapindex>' +
            ['one', 'two', 'three']
              .map((n) => `<sitemap><loc>${origin}/sm-${n}.xml</loc></sitemap>`)
              .join('') +
            '</sitemapindex>',
        );
        return;
      }
      const name = (req.url ?? '').replace('/sm-', '').replace('.xml', '');
      res.end(
        sitemapOf(Array.from({ length: 20 }, (_, i) => `${origin}/${name}/${i}/`)),
      );
    },
    async (base) => {
      const r = await fetchSitemap(`${base}/sitemap.xml`, 6);
      assert.equal(r.listed, 60);
      assert.equal(r.urls.length, 6);
      for (const child of ['one', 'two', 'three']) {
        assert.ok(
          r.urls.some((u) => u.includes(`/${child}/`)),
          `nothing from ${child}: the sample missed a third of the site`,
        );
      }
    },
  );
});

test('documents in a sitemap are dropped before anything is requested', async () => {
  await withServer(
    (req, res) => {
      const origin = `http://127.0.0.1:${res.socket.localPort}`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        sitemapOf([
          `${origin}/report.pdf`,
          `${origin}/photo.JPG`,
          `${origin}/real/`,
          'https://other-host.example/page/',
        ]),
      );
    },
    async (base) => {
      const r = await fetchSitemap(`${base}/sitemap.xml`, 50);
      assert.deepEqual(r.urls, [`${base}/`, `${base}/real/`]);
    },
  );
});

test('a front page listed in the middle of the sitemap is still read', async () => {
  await withServer(
    (req, res) => {
      const origin = `http://127.0.0.1:${res.socket.localPort}`;
      const urls = Array.from({ length: 100 }, (_, i) => `${origin}/p${i}/`);
      urls[50] = `${origin}/`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(sitemapOf(urls));
    },
    async (base) => {
      const r = await fetchSitemap(`${base}/sitemap.xml`, 4);
      assert.ok(r.urls.includes(`${base}/`));
      assert.equal(r.urls.length, 4, 'and the cap is still the cap');
      assert.ok(
        !r.notes.some((n) => n.includes('does not list the front page')),
        'it was listed, so nothing is claimed about it being missing',
      );
    },
  );
});

test('a site audit is titled after the site, and counts pages rather than files', async () => {
  // Both of these read as carelessness on a document whose whole job is to be handed to
  // the site's owner: a report titled after the directory the command was typed in, and
  // a count of "files" the reader does not have and cannot check.
  await withServer(
    (req, res) => {
      const origin = `http://127.0.0.1:${res.socket.localPort}`;
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(sitemapOf([`${origin}/a/`, `${origin}/b/`]));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE(`<main><h1>Т</h1>${FULL_BODY}<img src="x.png"></main>`));
    },
    async (base) => {
      const out = join(tmpdir(), `a11yfix-subject-${process.pid}.html`);
      try {
        await cliAsync(['--sitemap', `${base}/sitemap.xml`, '--report', out, '--quiet']);
        const html = readFileSync(out, 'utf8');
        assert.ok(
          html.includes(`<h1>Accessibility audit: ${base.replace('http://', '')}</h1>`),
          'the report is titled after the site, not the working directory',
        );
        assert.match(html, /pages scanned/);
        assert.ok(!/files scanned/.test(html), 'a site audit does not scan files');
        assert.ok(html.includes(`--sitemap ${base}/sitemap.xml --report`));
      } finally {
        rmSync(out, { force: true });
      }
    },
  );
});


/**
 * Completing a certificate chain the server did not send.
 *
 * Six of the forty-nine Russian institutional sites in the measurement corpus could not
 * be opened at all, with `unable to verify the first certificate`. Their certificates are
 * ordinary commercial ones; their servers send the leaf and omit the intermediate, and
 * every browser papers over it by fetching the missing link from the address inside the
 * certificate. Node does not, so the tool failed at the exact moment somebody tries it
 * for the first time.
 *
 * The repair itself is verified against the live web — six real hosts recovered, and
 * expired / self-signed / wrong-host / untrusted-root all still refused. What is checked
 * here is the two pieces that decide whether it ever runs, because both have failed
 * silently once already: the error shape, and the address parse.
 */

test('the incomplete-chain error is recognised in both shapes Node reports it in', () => {
  // fetch() buries it one level down; https.request puts it on the error itself.
  assert.ok(isIncompleteChain(Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    }),
  })));
  assert.ok(isIncompleteChain(Object.assign(new Error('x'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })));
});

test('every other trust failure is left alone', () => {
  // Repairing these would mean loading a page whose certificate is genuinely not to be
  // believed, which is a far worse failure than declining to read it.
  for (const code of [
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ECONNREFUSED',
    undefined,
  ]) {
    assert.equal(isIncompleteChain({ cause: { code } }), false, `${code} must not be repaired`);
  }
  assert.equal(isIncompleteChain(undefined), false);
  assert.equal(isIncompleteChain(new Error('plain')), false);
});

test('the issuer address is read out of the extension, and only from the right line', () => {
  const real =
    'OCSP - URI:http://ocsp.globalsign.com/gsgccr6alphasslca2025\n' +
    'CA Issuers - URI:http://secure.globalsign.com/cacert/gsgccr6alphasslca2025.crt\n';
  assert.equal(
    caIssuersFrom(real),
    'http://secure.globalsign.com/cacert/gsgccr6alphasslca2025.crt',
    'the OCSP responder is not the issuer, and fetching it would return something that is not a certificate',
  );
  assert.equal(caIssuersFrom(undefined), undefined);
  assert.equal(caIssuersFrom('OCSP - URI:http://ocsp.example/'), undefined, 'no issuer named');
  assert.equal(
    caIssuersFrom('CA Issuers - URI:ldap://directory.example/cn=CA'),
    undefined,
    'only addresses we can actually fetch',
  );
});

/**
 * The chain repair is only a repair because it refuses to be handed a trust store.
 *
 * The first version of it pushed every certificate it downloaded into `ca` and stopped
 * walking when one named no issuer — which is the definition of a self-signed root. So a
 * server that could not be verified could also serve, over plain http, the authority that
 * vouched for it, and it was believed: Node's own `fetch` rejected the connection and
 * this tool read the page. These two predicates are what closes that, so they are asserted
 * rather than described.
 *
 * The fixtures are a throwaway CA and a leaf it signed, generated once and dated far out
 * so the test does not start failing on a calendar. Nothing here touches the network:
 * `verify()` checks a signature, and a root in Node's own store signed itself, which is
 * both the positive case for one predicate and the reason the other exists.
 */
const UNTRUSTED_ROOT = `-----BEGIN CERTIFICATE-----
MIIDSTCCAjGgAwIBAgIUNHlXYmIiPXh1WPue6CeBMWbXK8UwDQYJKoZIhvcNAQEL
BQAwMzExMC8GA1UEAwwoQTExeUZpeCBUZXN0IFJvb3QgKG5vdCB0cnVzdGVkIGFu
eXdoZXJlKTAgFw0yNjA5MDIxNzQ4MTdaGA8yMTI2MDgwOTE3NDgxN1owMzExMC8G
A1UEAwwoQTExeUZpeCBUZXN0IFJvb3QgKG5vdCB0cnVzdGVkIGFueXdoZXJlKTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALoif1AApG7mV/b8q7GPYeCt
enWPwfnvM1yUnEpFOkn3miC1744X54qMTOy2+s6kYy0+OHVNzA+T4ikfWdPxV3hh
5+vADXnkTS/T4FGifuMqZrH4Cov4/oknO8areQDd/ONQgtUSYlyc/e2VWrq+l69H
14NYQLr6wslPElBBwSwG+aClONLui8Bxv3sZftdfc/IfhaQaIJ7nr3cT2vbZGlkP
0/47mjKgs0RhN2AjRXoLVePmaV5T/q/nuEzN9T2hpqDQ3JKAs9jz3SQgFagyvuXK
OFQwzNluQ0JyWQXBd8mRwcyQQtwFwJnwUOVCuglRLmeFegD6z0gsgIOeyFEtJusC
AwEAAaNTMFEwHQYDVR0OBBYEFFK2hmxD9ao1OfQKIST5EjqLzkANMB8GA1UdIwQY
MBaAFFK2hmxD9ao1OfQKIST5EjqLzkANMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBAIkJ2US7+K/ExvnspAViQAr+XaOHLv/2w0zpu5EeKAUMHqqR
9YShU7EVYZQcH7rCJxWLC3zI2/Wprug9dYp8ig/c0+r+3SjJjKiIDLjakawLfdPf
piD8263c5db8WezcHF4D5gmQ1icHMLnOgi+yM97bmXnafr+xvB5NaEWgkiZo5ElY
/kmnZGPeXlgzBAhmKt+Lou/RCsfcCANXejJQ9Jt39NqA5ZPl3uAb/gcdzVNTAdHd
KXKFnAnAtqQxGK3miSYxY4PysHEXEpU9igCxG5SBGDP8RtioiokbgiXX4nKz6Z8D
T9zwh2aVtNXnSp2s/bWLV1VVCb/pzifZkXziij0=
-----END CERTIFICATE-----`;

const UNTRUSTED_LEAF = `-----BEGIN CERTIFICATE-----
MIIDejCCAmKgAwIBAgIUF2wwatMfd61va57y+eB8oU9ZsqcwDQYJKoZIhvcNAQEL
BQAwMzExMC8GA1UEAwwoQTExeUZpeCBUZXN0IFJvb3QgKG5vdCB0cnVzdGVkIGFu
eXdoZXJlKTAgFw0yNjA5MDIxNzQ4MThaGA8yMTI2MDgwOTE3NDgxOFowFzEVMBMG
A1UEAwwMdGVzdC5pbnZhbGlkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEA0TuSZLL3PY3a9OlFIqYLh480lPVJeGAmUk/+Af1aOH2R1uuim3RWDmJ7ikHW
TLqikVV+TEBtuskwJr0SeQ6SKgnc7QalYHzCQWM8cEQGcqSduU7ySlOIEbI0HAeb
Hv+CCNDpDZQaCuKpnoKhgDfqbS6N1z4rrqH91gQlNa7M6siQVZ9kgPjKzv9+AL/P
wqt/pSNZ5/p+GYFVPVjfn3TjnZCErotG7GWq9wsXqFOgadeFOCfSTiKaiJnrosN9
QIKv8DQ4xl+cYzuocqFhoxOYCapXWYP8DUl7j+2i3+NPCbg+gktDaKMOxZEXKTxa
cVQund78PPiC3YHglz1CiyAgbQIDAQABo4GfMIGcMBcGA1UdEQQQMA6CDHRlc3Qu
aW52YWxpZDAJBgNVHRMEAjAAMDYGCCsGAQUFBwEBBCowKDAmBggrBgEFBQcwAoYa
aHR0cDovL3Rlc3QuaW52YWxpZC9jYS5kZXIwHQYDVR0OBBYEFPK/wIxIttRCtJWG
CNENbHXrI1KTMB8GA1UdIwQYMBaAFFK2hmxD9ao1OfQKIST5EjqLzkANMA0GCSqG
SIb3DQEBCwUAA4IBAQCmwOW1VHOdVqxtezXX5Sb5zw5Bp60IGAh+ixJP74OYgeYB
Sk/g8o4TBJUGULab69tTAbJQBa+j/5zs0UeyeOGZ0F+WSCxXZIm4nR9ZOzm46WYS
Bro0T3saUS6qvIJYHg1rfkclM344uYAVp5Zw9Zu/Z+AGwZ+aTsVYwTFeqVZGhupq
mLyXpy5YO1J4wvCU5h8Nmmy+XyL1RxHkwOJ79txvqrn6oVu1VAqVvuUBRlcUOjiT
J/eMrrwEGmlqPZfYBsiLfEx9G9Q1P4CqxHxtQLfp7PO6HqdZZul2XjG+b4wgTN5N
PgCPpC6f/OLNa0XkDGpifqg+x4ob2fDbLutw4hCT
-----END CERTIFICATE-----`;

test('a certificate that signed itself is recognised as a root, not a link', () => {
  assert.equal(isSelfSigned(new X509Certificate(UNTRUSTED_ROOT)), true);
  assert.equal(isSelfSigned(new X509Certificate(UNTRUSTED_LEAF)), false);
  // Every anchor in the store is self-signed. That is exactly why one arriving over the
  // wire cannot be told apart from a real one by anything but where it came from.
  assert.equal(isSelfSigned(new X509Certificate(rootCertificates[0])), true);
});

test('a certificate is only trusted when a root already in the store signed it', () => {
  // The forged leaf is signed by the forged root. Serving that root at the address the
  // leaf names is the whole attack, and it has to answer false here.
  assert.equal(signedByKnownRoot(new X509Certificate(UNTRUSTED_LEAF)), false);
  assert.equal(signedByKnownRoot(new X509Certificate(UNTRUSTED_ROOT)), false);
  // A root in Node's store is signed by a root in Node's store: itself.
  assert.equal(signedByKnownRoot(new X509Certificate(rootCertificates[0])), true);
});

/**
 * Following a redirect is the only moment this tool connects somewhere nobody asked it
 * to, and the README's own workflow is what makes that matter: an agency is told to scan
 * a URL a stranger sent, and to email the resulting report back. A redirect into the
 * agency's own network turns that report into a disclosure.
 *
 * The rule enforced here is about the boundary rather than the destination. A scan that
 * starts public stays public; a scan that starts private is your own network already, so
 * `a11yfix http://localhost:3000` keeps working — refusing it would be a security check
 * that makes the tool worse at its job.
 *
 * The public-to-private case cannot be reached from a test suite: it needs a genuinely
 * public host that redirects inward, and there is not one to hand. So the decision itself
 * is asserted, and the cases that can be reached are driven through the real fetch.
 */
test('an address is classified by what it is, not by how it is spelled', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateIp(ip), true, ip + ' should be private');
  }
  // The neighbours of each range, which a sloppy check swallows along with it.
  for (const ip of [
    '172.15.0.1', '172.32.0.1', '192.167.1.1', '100.128.0.1', '8.8.8.8',
    '104.20.23.154', '172.66.147.243', '::ffff:8.8.8.8', '2606:4700::1',
  ]) {
    assert.equal(isPrivateIp(ip), false, ip + ' should be public');
  }
});

test('a hostname is resolved before it is judged', async () => {
  // The case a pattern match cannot catch, and the reason this does a lookup at all:
  // 127.0.0.1.nip.io is an ordinary public hostname that resolves to loopback. Anyone
  // can point a name they own at any address they like.
  assert.equal(await resolvesPrivate('127.0.0.1.nip.io'), true);
  assert.equal(await resolvesPrivate('localhost'), true);
  assert.equal(await resolvesPrivate('127.0.0.1'), true);
  assert.equal(await resolvesPrivate('[::1]'), true);
  // A name that does not resolve is treated as private. The request is going to fail
  // anyway, and answering "public" for a lookup that failed would make the check
  // bypassable by breaking DNS at the right moment.
  assert.equal(await resolvesPrivate('nx.invalid'), true);
});

test('a redirect may not carry a public scan into a private network', async () => {
  const from = new URL('https://example.ru/');
  await assert.rejects(
    () => refuseCrossingInward(from, new URL('http://169.254.169.254/latest/meta-data/'), true),
    /private network/,
    'the cloud metadata service is the address this exists for',
  );
  await assert.rejects(
    () => refuseCrossingInward(from, new URL('http://192.168.1.1/'), true),
    /private network/,
  );
  await assert.rejects(
    () => refuseCrossingInward(from, new URL('http://127.0.0.1.nip.io:8080/'), true),
    /private network/,
    'a public hostname resolving inward is the whole point of resolving',
  );
  // Public to public is ordinary, and private to anywhere is your own network.
  await refuseCrossingInward(from, new URL('https://example.com/moved'), true);
  await refuseCrossingInward(new URL('http://localhost:3000/'), new URL('http://127.0.0.1:9/'), false);
});

test('a scan that starts on your own machine still follows its own redirects', async () => {
  // The regression this fix could easily have caused. Running a dev server and pointing
  // the tool at it is an ordinary thing to do, and it goes through the same code.
  const html = '<!doctype html><html lang="en"><head><title>t</title></head><body><main><p>ok</p></main></body></html>';
  await withServer(
    (req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: '/there' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    },
    async (base) => {
      const page = await fetchPage(base + '/hop');
      assert.match(page.html, /<p>ok<\/p>/);
      assert.match(page.url, /\/there$/);
      assert.ok(
        page.notes.some((n) => n.includes('redirected to')),
        'a redirect that was followed is still said out loud in the report',
      );
    },
  );
});

test('a redirect out of http is refused, and a loop ends', async () => {
  await withServer(
    (req, res) => {
      const to = req.url === '/file' ? 'file:///etc/passwd' : '/loop';
      res.writeHead(302, { location: to });
      res.end();
    },
    async (base) => {
      await assert.rejects(() => fetchPage(base + '/file'), /refused to follow a redirect to file:/);
      await assert.rejects(() => fetchPage(base + '/loop'), /too many redirects/);
    },
  );
});

test('the redirect cap is a real bound, and it is not tighter than the web is', async () => {
  // Following redirects here rather than in undici moved this number from undici's
  // twenty to ours. A real site can spend several hops on http-to-https, bare-to-www, a
  // locale prefix and a trailing slash, so the bound is asserted from both sides: the
  // longest chain that must still work, and the first one that must not.
  await withServer(
    (req, res) => {
      const left = Number(/^\/(\d+)$/.exec(req.url)?.[1] ?? '0');
      if (left > 0) {
        res.writeHead(302, { location: '/' + (left - 1) });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html lang="en"><head><title>t</title></head><body><main><p>ok</p></main></body></html>');
    },
    async (base) => {
      const page = await fetchPage(base + '/10');
      assert.match(page.html, /<p>ok<\/p>/);
      await assert.rejects(() => fetchPage(base + '/11'), /too many redirects/);
    },
  );
});

test('a sitemap index may not send the scan to another host', async () => {
  // A sitemap index is the one document that hands a remote party a whole URL for this
  // tool to GET, with no page ever rendered from it — the reply is parsed as XML and its
  // <loc> entries end up in the report. Page URLs were already filtered to the origin;
  // child sitemaps were not, which made an index the shortest path from "scan my site"
  // to a request against 169.254.169.254 with the answer reflected back.
  let internalHits = 0;
  const internal = createServer((req, res) => {
    internalHits += 1;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end('<?xml version="1.0"?><urlset><url><loc>http://elsewhere.invalid/leaked</loc></url></urlset>');
  });
  internal.listen(0, '127.0.0.1');
  await once(internal, 'listening');
  const internalPort = internal.address().port;

  try {
    await withServer(
      (req, res) => {
        const origin = `http://127.0.0.1:${res.socket.localPort}`;
        res.writeHead(200, { 'content-type': 'application/xml' });
        if (req.url === '/sitemap.xml') {
          res.end(
            '<?xml version="1.0"?><sitemapindex>' +
              `<sitemap><loc>http://127.0.0.1:${internalPort}/latest/meta-data/</loc></sitemap>` +
              `<sitemap><loc>${origin}/real.xml</loc></sitemap>` +
              '</sitemapindex>',
          );
          return;
        }
        res.end(sitemapOf([`${origin}/a/`, `${origin}/b/`]));
      },
      async (base) => {
        const r = await fetchSitemap(`${base}/sitemap.xml`, 6);
        assert.equal(internalHits, 0, 'the foreign sitemap was fetched');
        assert.ok(
          r.urls.every((u) => u.startsWith(base)),
          `a URL escaped the origin: ${r.urls.join(' ')}`,
        );
        // The same-origin child is still read, so the check is a boundary and not a ban.
        assert.ok(r.urls.some((u) => u.endsWith('/a/')));
        assert.ok(
          r.notes.some((n) => n.includes('could not be read')),
          'the skipped sitemap was not reported: a silent drop reads as an empty site',
        );
      },
    );
  } finally {
    internal.close();
    await once(internal, 'close');
  }
});

test('a Location header carrying raw UTF-8 resolves to the path the server meant', async () => {
  // Header values arrive as bytes and both clients hand them over decoded as latin1, so a
  // CMS that redirects to an unencoded Cyrillic slug produces mojibake. Passing that
  // straight to `new URL` percent-encodes the mojibake — %C3%91%C2%81 where the server
  // meant %D1%81 — and the second request 404s. undici does the recovery itself when it
  // follows redirects internally; following them by hand has to do it too, or this is a
  // step backwards from `redirect: 'follow'`.
  const seen = [];
  await withServer(
    (req, res) => {
      seen.push(req.url);
      if (req.url === '/') {
        res.socket.write(
          Buffer.concat([
            Buffer.from('HTTP/1.1 302 Found\r\nLocation: ', 'latin1'),
            Buffer.from('/статья', 'utf8'),
            Buffer.from('\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', 'latin1'),
          ]),
        );
        res.socket.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE(FULL_BODY));
    },
    async (base) => {
      const page = await fetchPage(`${base}/`);
      assert.deepEqual(seen, ['/', '/%D1%81%D1%82%D0%B0%D1%82%D1%8C%D1%8F']);
      assert.ok(page.url.endsWith('/%D1%81%D1%82%D0%B0%D1%82%D1%8C%D1%8F'), page.url);
    },
  );
});
