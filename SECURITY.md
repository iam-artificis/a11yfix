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
stylesheets it links from its own origin. Two known limits, stated rather than implied:

- **Redirects are followed without re-checking where they lead.** A URL you were sent by
  someone else can redirect into your own network, and the resulting report can contain
  paths and file names from it. If you scan a URL a stranger supplied and then send the
  report back to them, read it first.
- **The scheme is checked; the address is not.** Only `http` and `https` are accepted, but
  nothing refuses a hostname that resolves inside your network. The one exception is the
  certificate-authority address described below, which does refuse the obvious internal
  literals.

Neither is remotely exploitable — this is a command-line tool, not a service, and whoever
gives you the URL never sees the response. Both are on the list to fix properly, with
per-hop address validation.

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
