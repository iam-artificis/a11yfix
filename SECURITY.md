# Security

## Reporting

Report privately, through
[GitHub Security Advisories](https://github.com/iam-artificis/a11yfix/security/advisories/new),
not the issue tracker. You will get a first response within a week.

Apache-2.0, no warranty, one maintainer: there is no paid support and no guaranteed patch
window. What there is, is that a report of the two things below will be treated as more
urgent than anything else in the project.

## What this tool can do to you

Two of its capabilities are worth stating plainly, because both are unusual for a linter
and both are the reason this file exists.

**It writes to your source files.** `--fix` edits the files it scanned, in place. It only
writes to paths it discovered by walking the directory you named, it does not follow
symlinks out of that tree, and every edit is bounds-checked against the file it was
generated from. A way to make it write outside the tree you pointed it at, or to write
content it did not compute from your own source, is the most serious class of bug this
project can have.

**It fetches URLs you give it.** `a11yfix https://example.ru/` retrieves the page and the
stylesheets it links from its own origin, and follows redirects itself rather than letting
`fetch` do it — because following a redirect is the only moment the tool connects
somewhere nobody asked it to.

The rule is about the boundary, not the destination: **a scan that starts on the public
internet is refused when a redirect would take it into a private network.** Loopback,
link-local — including `169.254.169.254`, the cloud metadata service — RFC1918,
carrier-grade NAT, unique-local and multicast are all refused as a redirect target, and
the hostname is *resolved* before it is judged, because `127.0.0.1.nip.io` is a public
name pointing at loopback and anyone can register another. Addresses are classified by
their bytes rather than by how they are spelled: `http://[::ffff:127.0.0.1]/` is
normalised by `new URL` to `[::ffff:7f00:1]`, and a check that reads the text misses it.
A redirect out of `http`/`https` is refused outright, and a sitemap index may only send
the tool to child sitemaps on the origin it was fetched from.

A scan that starts private is your own network already, so `a11yfix http://localhost:3000`
works and follows its redirects normally. Refusing that would be a security check that
makes the tool worse at the thing it is for.

**The limit of that guarantee, stated rather than glossed.** The address is resolved to
decide, and resolved again by the HTTP client to connect — two lookups, and a name server
that answers them differently defeats the check. The only real fix is to pin the address
that was judged into the socket that is opened, and no Node API reaches that far without a
custom `undici` dispatcher, which zero runtime dependencies rules out. So read the claim
as what it is: it stops a redirect chain from wandering into your network, not an attacker
who controls DNS for a name you chose to scan. If that is your threat model, run the tool
where a private address cannot be reached at all — the network is the right layer for it.

The address a certificate names for its issuer is held to the stricter rule — always
public, whatever is being scanned — because that address is chosen entirely by the remote
party, from a certificate that has not been verified yet.

What this does not do is stop *you* pointing it at your own network on purpose, and it
never will: that is a legitimate scan, and the report will contain internal paths. If you
scanned a URL somebody else supplied, read the report before you send it back.

**What it will not do:** run JavaScript from a page it fetched, execute anything from your
source, evaluate a config file as code, or run an install-time script. It has zero runtime
dependencies, and that is a permanent design constraint rather than a current fact.

## TLS

`src/fetch.ts` completes a certificate chain a server did not send, by reading the address
out of the certificate's Authority Information Access extension and fetching the missing
link — which is what a browser does, and without it six of the forty-nine institutional
sites this feature was written for could not be read at all.

That mechanism is only safe under a condition that is easy to get wrong, and this project
got it wrong once. Anything fetched that way is refused unless a root **already in Node's
own store** signed it, and a self-signed certificate is refused outright. The earlier
version pushed every downloaded certificate into the trust store and stopped walking when
one named no issuer — the definition of a self-signed root — so a server that could not be
verified could also supply, over plain http, the authority vouching for it. `fetch()`
rejected such a connection; a11yfix read the page.

Both halves of the property are asserted in `test/fetch.test.js`, not described here.
A change that weakens either one is a security regression regardless of what it enables.

The address in the AIA extension is fetched over plain `http` by design — that is how the
protocol works, and it is why the certificate it returns is verified against Node's roots
before anything is done with it, rather than trusted for having arrived.

## Scope

**In scope:** anything that makes the tool write a file it should not, write content it did
not derive from your source, trust a certificate it should not, or execute code from
scanned input, a config file, or a fetched page.

**Not in scope:** a wrong or missing accessibility finding. That is a correctness bug —
open an issue, and a false positive is the most useful report this project takes. Denial of
service against your own machine from input you supplied is also not a vulnerability here,
though it is a bug worth reporting: a deliberately crafted document can make the parser
spend a long time on it.

## Supported versions

The latest published version. There is no back-porting.
