// Builds the source-fallback fixture from a playable AV1 MP4. Usage:
//   node scripts/make-fallback-fixture.js <in.mp4> <out.mp4>
//
// The output keeps every byte before the first frame. It then writes that frame
// at its full size with every byte set to 0xFF, and ends. The library falls back
// only on a media `error` with code 3 or 4 (isUnusable in src/sources.ts). Each
// engine fires one for this file. Measured on 2026-11-16 with Playwright 1.63.0
// and 1.65.1 on Linux, and 1.65.1 on macOS:
//
// - Chromium 153 and 159: code 3, "dav1d_send_data() failed with error -22".
// - Firefox 155: code 3, "OBU size was too large".
// - Firefox 159: code 3, "Sample data byte range beyond end of resource".
// - WebKit 26.6 and 27.2 on Linux: code 4.
// - WebKit 27.2 on macOS: code 4, but only with `src` set directly.
//
// macOS WebKit 27.2 answers "" to canPlayType for this AV1 type. So the library
// skips the file there and loads the next source. Only Chromium, Firefox and
// Linux WebKit run the library's error path with this file.
//
// Both the full-size frame and the early end are needed. A file cut inside the
// first frame fires no `error` in WebKit 27.2 on Linux, and the video stays at
// readyState 0. That WebKit plays media through GStreamer's playbin3 by default
// (https://bugs.webkit.org/show_bug.cgi?id=236884). Measured: with
// WEBKIT_GST_USE_PLAYBIN2=1 it fires code 4 again. A full-length file with all
// its video data set to 0xFF fails the other way. Firefox plays it on Linux and
// macOS with no `error`.
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('usage: node scripts/make-fallback-fixture.js <in.mp4> <out.mp4>');
}

const file = readFileSync(input);

/**
 * The boxes directly inside a box's payload, with their own payload ranges.
 * Only the plain 32-bit size is read. ffmpeg writes that form for these short
 * clips, so any other form fails here as malformed.
 */
function boxes({ start, end }) {
  const found = [];
  let at = start;
  while (at < end) {
    const size = file.readUInt32BE(at);
    if (size < 8 || at + size > end) {
      throw new Error(`${input}: malformed box at byte ${at}`);
    }
    found.push({ type: file.toString('latin1', at + 4, at + 8), start: at + 8, end: at + size });
    at += size;
  }
  return found;
}

/**
 * The one box of this type inside a parent. Exactly one, so a second track
 * fails here too. That track's samples could sit before the video's first frame.
 */
function only(parent, type) {
  const matches = boxes(parent).filter((box) => box.type === type);
  if (matches.length !== 1) {
    throw new Error(`${input}: expected one ${type} box, found ${matches.length}`);
  }
  return matches[0];
}

const moov = only({ start: 0, end: file.length }, 'moov');
const trak = only(moov, 'trak');
const stbl = only(only(only(trak, 'mdia'), 'minf'), 'stbl');
const stsz = only(stbl, 'stsz');
const chunkOffsets = only(stbl, 'stco');

// Field offsets from ISO/IEC 14496-12. Each payload opens with 4 bytes of
// version and flags. stsz then holds a size every frame shares, the frame count,
// and one size per frame when the shared size is 0. stco holds the chunk count,
// then each chunk's file offset.
if (file.readUInt32BE(stsz.start + 8) === 0 || file.readUInt32BE(chunkOffsets.start + 4) === 0) {
  throw new Error(`${input}: the video has no frames`);
}
const frameSize = file.readUInt32BE(stsz.start + 4) || file.readUInt32BE(stsz.start + 12);
// The first frame is the first sample of the first chunk, so it starts there.
const frameStart = file.readUInt32BE(chunkOffsets.start + 8);
// The cut keeps only what comes before that frame. A moov written after the
// media data would be cut away, and every engine would then reject the file as
// an unknown container, which is not the failure the tests are for.
if (moov.end > frameStart) {
  throw new Error(`${input}: moov must come before the media data (encode with +faststart)`);
}

writeFileSync(output, Buffer.concat([file.subarray(0, frameStart), Buffer.alloc(frameSize, 0xff)]));
