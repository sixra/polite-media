# Contributing

## Getting set up

Node 26 and pnpm. `pnpm install` also installs the git hooks.

```sh
pnpm install
pnpm verify     # lint, format, typecheck, unit tests, build, size budgets
pnpm test:e2e   # Playwright, all three engines
```

`pnpm verify` runs automatically before you push to `main`.

## Commits

Conventional Commits, enforced by `commitlint` on the `commit-msg` hook. This is a
correctness gate rather than a style one: the release version is derived from these
subjects, so a malformed one produces the wrong bump or no release.

`feat:` is a minor, `fix:` a patch, and `!` marks a breaking change.
[`RELEASING.md`](RELEASING.md) records what counts as this package's public API,
which is wider than the function signatures: the data attributes, the CSS custom
properties, the published stylesheet selectors and the defaults are all part of it.

## The two rules that are not obvious

**Behaviour is proven in a browser, and every test is mutation-tested.** Unit tests
run against happy-dom, which implements no media playback, so anything about
playback, reveal timing or visibility belongs in the Playwright suite. Before
trusting a new test, break the line it defends and watch it go red. Several tests in
this repo's history passed while asserting nothing, and each was caught this way and
not by review.

**A claim needs a source or a test.** If you add "X is faster" or "browser Y does
Z", link the spec or vendor documentation that says so, or add a test that
demonstrates it. Where something cannot be verified, label it as unverified rather
than stating it flatly. Quote a source and link it in the same place.

## Size budgets

`pnpm size` measures each entry point bundled, minified and gzipped, and fails if a
budget is exceeded **or if the README quotes a different number**. If a change costs
bytes, raise the budget and update the README table in the same commit, and say in
the message what the bytes bought.

## What this package deliberately is not

It sets no width, height or aspect ratio; your CSS owns layout and it owns timing.
It is not an image pipeline, not a lazy-loader for images, not a player and not a
scroll-animation library. Proposals that move it toward any of those are likely to
be declined, so it is worth opening an issue before writing the code.
