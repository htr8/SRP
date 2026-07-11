# Vendored third-party code

## SignalsmithStretch.js

- Package: `signalsmith-stretch` 1.3.2 — official JS/WASM release of the Signalsmith Stretch
  time-stretch/pitch-shift library (https://signalsmith-audio.co.uk/code/stretch.git)
- Author: Geraint Luff (Signalsmith Audio)
- License: MIT
- Vendored on 2026-07-06 so the app works offline in every BlazorWebView. Renamed from the
  upstream `.mjs` to `.js` (content unmodified) because the MAUI BlazorWebView serves `.mjs`
  as `application/octet-stream`, which strict ES-module MIME checking rejects; `.js` is served
  as `text/javascript` on every platform.
  Used by `js/audioPlayer.js` as the primary tempo/pitch engine (see
  docs/08_Audio_Engine/AudioStretchQuality.md).

### LOCAL PATCH — re-apply on any re-vendor!

The file carries one MasteryCoach modification that upstream does not have: a
`replaceChannels(startChannel, sampleBuffers)` method on the stretch node (marked
`// MasteryCoach patch (not upstream)` in the file, near the other instance methods). It swaps
one contiguous channel run of the buffered segment in place and returns `false` on any
layout/length mismatch — `js/stemPlayer.js` (`replaceStemFromStream`) uses it for the
single-stem click-track swap so a re-render doesn't reload every stem.

Upgrading the vendored file WITHOUT re-applying this patch silently breaks the single-stem
swap (it degrades to a full reload at best). If you bump the version: diff the current file
against upstream 1.3.2 to extract the patch, apply it to the new version, and update this note.
