#!/bin/sh
# Generates the demo/test media. Nothing here is committed: the fixtures are
# synthetic so the repo carries no third-party or client imagery.
#
# testsrc2 is used deliberately over a static gradient -- it animates and draws a
# frame counter, so a stalled video is visually obvious and the poster (frame 0)
# is provably a different picture from any later frame.
set -eu

out="$(dirname "$0")/../demo/assets"
mkdir -p "$out"

size=1280x720
rate=30
secs=4

# -an strips the audio track. web.dev: this shrinks the file even when the source
# audio is already silent, and every video this library targets is muted anyway.
common="-y -hide_banner -loglevel error -f lavfi -i testsrc2=s=$size:r=$rate:d=$secs -an -pix_fmt yuv420p"

echo "h264 ..."
# shellcheck disable=SC2086
ffmpeg $common -c:v libx264 -preset veryfast -crf 30 -movflags +faststart "$out/sample-h264.mp4"

echo "av1 ..."
# shellcheck disable=SC2086
ffmpeg $common -c:v libsvtav1 -preset 8 -crf 40 -movflags +faststart "$out/sample-av1.mp4"

# Frame 0 exactly, so poster and first video frame are the same picture and the
# crossfade has nothing to dissolve between. This is the contract the library
# documents, so the fixtures have to honour it.
echo "poster ..."
ffmpeg -y -hide_banner -loglevel error -i "$out/sample-h264.mp4" \
  -vf "select=eq(n\,0)" -vframes 1 -q:v 3 "$out/sample-poster.jpg"
ffmpeg -y -hide_banner -loglevel error -i "$out/sample-h264.mp4" \
  -vf "select=eq(n\,0)" -vframes 1 "$out/sample-poster.avif"

# A truncated AV1 file, for exercising error-driven source fallback without an
# Apple device that claims AV1 it cannot decode.
#
# Verified in Chromium (docs/findings.md): raises a media `error` after ~17 ms
# with code 3, MEDIA_ERR_DECODE -- the same class of failure as the real Apple
# case, not merely a stall. Re-check if the encoder or truncation size changes:
# a fixture that stalls instead of erroring would make fallback tests pass for
# the wrong reason.
echo "truncated av1 (fallback fixture) ..."
head -c 2048 "$out/sample-av1.mp4" > "$out/sample-truncated-av1.mp4"

ls -lh "$out"
