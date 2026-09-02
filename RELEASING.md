# Releasing

## What decides the version

Semver says MAJOR "MUST be incremented if any backward incompatible changes are
introduced to the public API", and then declines to define what incompatible means.
So the useful half is writing down what the public API of this package actually is.
It is wider than the function signatures:

| part of the API                   | example                                           | breaking it means                        |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| exported functions and options    | `register`, `configure`, `warm`                   | a signature or option removed or renamed |
| event names and constants         | `polite-video:ready`                              | a listener silently stops firing         |
| attributes consumers **write**    | `data-polite-media`, `data-polite-reveal`         | their markup stops working               |
| attributes the library **writes** | `data-polite-paused`                              | their CSS stops matching                 |
| CSS custom properties             | `--polite-fade`, `--polite-failsafe`              | their tuning is ignored                  |
| published stylesheet selectors    | `layer.css`'s `> :is(img, video)`                 | their layout breaks                      |
| **defaults**                      | `startWhen`, `--polite-fade: 0s`                  | rendering changes with no code change    |
| the markup contract               | direct-parent rule, unconditional last `<source>` | works until it does not                  |

The last two are the ones that get missed, and both have already shipped here.
`feat!: default the video fade to 0s` changed no signature at all, and
`refactor!: rename the pause control attribute and event constant` was "just a
rename". Both broke consumers.

## The rule

| commit                                              | effect     |
| --------------------------------------------------- | ---------- |
| `feat!:` or `fix!:`, or a `BREAKING CHANGE:` footer | breaking   |
| `feat:`                                             | minor      |
| `fix:` or `perf:`                                   | patch      |
| `docs:` `test:` `chore:` `build:` `ci:` `style:`    | no release |

**Mark breaking changes with `feat!:` or `fix!:`, not `refactor!:`.** A `refactor!`
bumps the version from inside a changelog section that is hidden, which produces a
release whose notes explain nothing.

The format is enforced at commit time; see
[`CONTRIBUTING.md`](CONTRIBUTING.md#commits).

## While the package is below 1.0.0

A breaking change bumps the **minor**, not the major: 0.2.0 to 0.3.0. Semver clause 4
allows it, "Major version zero (0.y.z) is for initial development. Anything MAY change
at any time."

**Go to 1.0.0 once iOS Safari has exercised the refused-`play()` retry path.**
Playwright's WebKit does not stand in for it, so that is the one path the test
matrix cannot reach, and the likeliest source of a breaking fix.

At 1.0.0, delete the sentence in `CHANGELOG.md` that says a minor may still break
things.

## Publishing

### The first publish, once

Trusted publishing cannot create a package that does not exist yet
(npm/cli#8544), so the first one is manual:

```sh
pnpm verify
npm publish --access public
```

Then, on npmjs.com, configure the package's trusted publisher: the GitHub
organisation or user, the repository, and the workflow filename **`release.yml`**.
Delete the token afterwards. **Do not rename that workflow file**, or the trust
silently stops matching.

### Every publish after that

Tag and push. `.github/workflows/release.yml` runs the gate and publishes over OIDC
with no token, and npm attaches a provenance attestation automatically.

```sh
git tag -a v0.3.0 -m "polite-media 0.3.0

<what changed, in a sentence or two>"
git push origin main v0.3.0
```

To confirm the provenance attestation landed, ask the registry about the published
package. This works from anywhere and needs nothing installed:

```sh
npm view polite-media dist.attestations
```

Published with provenance, it prints an attestation URL and
`predicateType: 'https://slsa.dev/provenance/v1'`. Published without, it prints
nothing at all, which is the failure you are looking for. The package page on
npmjs.com shows the same thing as a "Provenance" panel naming the commit and the
workflow that built it.

(`npm audit signatures` is the other command in npm's docs, but it audits whatever
project you run it in, so in this repo it reports on the devDependency tree and
says nothing about polite-media.)

## What is deliberately not automated

- **The README byte figures.** `pnpm size` already fails when they drift, and it
  has caught a real one. Anything that updated them automatically would defeat the
  check.
- **The changelog wording.** Written by a person, in plain language: what is new,
  what changed, what was fixed.

## Before the repo goes public

Four things are true only while this is private and unpublished:

- `README.md`, the **Unpublished** paragraph, which says the package is not on the
  registry and to depend on it by path. Replace it with the install line.
- `README.md`, the **Nothing runs this in production yet** paragraph. Delete it once
  that stops being true, and not before.
- Any consumer depending on this package with `link:` is ignoring versions
  entirely. Move those to a real version range once there is something to point at.
- **Enable private vulnerability reporting** on the Security tab. It is
  public-repositories-only, so it cannot be switched on sooner, and until it is the
  button `SECURITY.md` points at does not exist.
