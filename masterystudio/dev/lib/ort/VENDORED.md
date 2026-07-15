# Vendored: onnxruntime-web 1.27.0 (wasm backend subset)

- Package: `onnxruntime-web@1.27.0` (npm), MIT license (Microsoft).
- Files: `ort.wasm.min.mjs` (API, wasm EP only), `ort-wasm-simd-threaded.mjs` + `.wasm` (the unified
  runtime — works single-threaded without SharedArrayBuffer, multi-threaded with it).
- **The version is pinned by the 2026-07-12 in-browser spike** (docs/08_Audio_Engine/
  StemSeparationPlan.md §4b): 1.27.0 + `graphOptimizationLevel: 'disabled'` is the proven
  combination that keeps the htdemucs_6s session inside the wasm32 4 GB cap. Do not bump this
  without re-running the spike matrix (prototypes/WebOnnxSeparationSpike).
- The webgpu/jsep/jspi/asyncify artifacts are deliberately NOT vendored — WebGPU measured slower
  than wasm for this graph (spike §4b) and the wasm EP never requests them.

The sibling `coi-serviceworker.min.js` at the wwwroot root is `coi-serviceworker@0.1.7` (MIT,
Guido Zuidhof) — grants `crossOriginIsolated` (COOP/COEP) on hosts that can't send the headers,
e.g. GitHub Pages, so ort can use wasm threads. It must live at the app root (a service worker
only controls its own directory scope).
