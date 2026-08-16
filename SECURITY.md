# Security

## Supported versions

While this package is on `0.x`, only the latest published version is supported.
Fixes land on `main` and go out in the next release rather than being backported.

## Reporting a vulnerability

Please report privately rather than opening a public issue.

Use GitHub's **Report a vulnerability** button on this repository's Security tab.
That opens a private advisory visible only to the maintainers.

If that button is not present, the repository has not enabled private reporting
yet. In that case open an issue asking for a security contact, **without
describing the vulnerability**, and you will be given somewhere private to send
the details.

## Scope

This package ships browser code with **no runtime dependencies**. It performs no
network requests of its own beyond the media the host page already declares, sets
no cookies, reads no storage, and writes no HTML: every DOM write is a fixed
attribute name or a URL assigned to `src`, `srcset` or `sizes` on an element it
created.

So the plausible issues are narrow: a way to make it write an attribute or URL the
host page did not supply, a way to make it fetch something the page's Content
Security Policy would have blocked, or anything in the published tarball that is not
`dist`, `src` or `CHANGELOG.md`.
