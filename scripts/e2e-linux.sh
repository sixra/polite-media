#!/bin/sh
# Runs the Playwright suite inside Playwright's Linux image, for failures that
# only CI shows. WebKit, for one, plays media through GStreamer on Linux and
# through AVFoundation on macOS. Arguments go on to `playwright test`, so
# `sh scripts/e2e-linux.sh --project=webkit` runs one engine.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not running. Start Docker Desktop with: docker desktop start" >&2
  exit 1
fi
# The demo pages import the package from dist/, so the tests need a build.
if [ ! -d "$root/dist" ]; then
  echo "error: dist/ is missing. Run pnpm build first, or pnpm test:e2e:linux." >&2
  exit 1
fi

# Playwright finds its browsers only in the image of its own version.
version="$(node -p 'require(process.argv[1]).version' "$root/node_modules/@playwright/test/package.json")"

# resolute is Ubuntu 26.04, which CI's ubuntu-latest runs. CI installs GStreamer
# from the runner's apt, so its package revision can differ from the image's.
# On an Apple Silicon Mac the container also runs arm64, where CI runs x86-64.
image="polite-media-e2e:$version"

# The image has no ffmpeg, and the fixtures need it. Docker caches this layer,
# so only the first run for each Playwright version installs it.
docker build --tag "$image" - <<EOF
FROM mcr.microsoft.com/playwright:v$version-resolute
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg
EOF

# The repo is read-only in the container, so a run cannot change the checkout.
# Linux and macOS encode the fixtures differently, so the container makes its
# own on a tmpfs over demo/assets. Docker cannot create that folder inside a
# read-only mount, and a fresh clone has none.
mkdir -p "$root/demo/assets"

# --init and --ipc=host follow https://playwright.dev/docs/docker.
docker run --rm --init --ipc=host \
  --volume "$root:/work:ro" \
  --tmpfs /work/demo/assets \
  --workdir /work \
  --env CI=1 \
  "$image" \
  sh -c 'sh scripts/make-fixtures.sh && exec node node_modules/@playwright/test/cli.js test --output=/tmp/test-results "$@"' \
  sh "$@"
