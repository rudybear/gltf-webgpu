# Khronos Verification Report

Verification of this viewer against the official Khronos repositories, run 2026-07-29:

- **glTF-Sample-Assets** (159 models, 333 asset variants) — loader + render verification
- **glTF-Test-Assets-Interactivity** (145 test graphs, 647 sub-tests) — KHR_interactivity conformance
- **glTF-Sample-Viewer** — cloned as reference implementation (`external/glTF-Sample-Viewer`)

All three repos live under `external/` (gitignored).

## How to reproduce

```bash
# Loader corpus (headless, Node): parses + builds render scenes for every variant
node scripts/verify-assets.mjs --json reports/asset-load-report.json

# Render corpus (headless Chrome + WebGPU): renders each model in the real viewer,
# writes screenshots + side-by-side gallery vs official Khronos screenshots
node scripts/render-verify.mjs
# -> reports/render/report.json, reports/render/gallery.html

# KHR_interactivity conformance (official protocol: run graph, tick for
# expectedDuration, judge by graph-computed HasPassed variables)
npm run test:interactivity
```

## Results

### Loader corpus: 310 / 333 variants pass

All 23 failures are variants requiring compressed-geometry extensions we do not
implement (`KHR_draco_mesh_compression` — 18, `EXT/KHR_meshopt_compression` — 5).
They fail with clean errors. Every variant not gated on those extensions loads.

### KHR_interactivity: 145 / 145 official tests pass (647 sub-tests)

The runner was re-pointed from a stale January 2026 snapshot (111 tests) to the
current corpus and rewritten to follow the official protocol described in the
corpus README.

### Render corpus: 148 / 148 models render

Every model with a core (non-Draco/Meshopt) variant renders with visible content
in headless Chrome + WebGPU after the fixes below. See
`reports/render/gallery.html` for our render next to the official Khronos
screenshot for every model. Known limitations (not bugs):

- Assets lit only by `KHR_lights_punctual` render with IBL only (punctual lights
  not implemented in the renderer).
- Draco/Meshopt-compressed variants do not load (as above).

## Defects found and fixed during verification

Loader (`src/gltf/index.ts`):
1. **Interleaved accessors over-read their buffer view** — DataView length was
   `count * byteStride` instead of `(count - 1) * stride + elementSize`, so any
   accessor whose byteOffset sat late within the stride threw
   ("Invalid DataView length"). Broke `ClearCoatTest`, `TextureTransformMultiTest`.
2. **External-file URI lookup was exact-match only** — URIs like
   `./chair_fabric_normal.png` or percent-encoded names failed to resolve against
   drag-and-drop file maps. Broke all `SheenChair/glTF` images. Now normalized
   (decode, strip `./`, basename fallback).

Renderer (`src/renderer/renderer.ts`, `src/renderer/camera.ts`):
3. **Index buffers with non-4-multiple byte lengths invalidated the whole frame** —
   the buffer was created at unpadded size while writes are 4-byte padded; a
   single 3-index primitive blanked the entire scene (`Triangle`, `SimpleMaterial`,
   Draco-adjacent models, etc.).
4. **Hard-coded far plane (100) and absolute zoom clamps** — models larger than
   ~40 units (`Fox`, `VirtualCity`, `NodePerformanceTest`) framed at distance
   > 100 were entirely clipped. Near/far and zoom limits now scale with the
   framed distance.

Interactivity runtime (`packages/interactivity/src/runtime.ts`) — brought up to
the current spec (spec copy: `external/KHR_interactivity-spec.adoc`):
5. `ref` value type (null refs, literals, `ref/eq`).
6. Typed JSON Pointer templates — `[param]` integer vs `{param}` reference
   parameters, with prefix-validated reference substitution.
7. Capability/limit virtual pointers (`asset/majorVersion`, `asset/minorVersion`,
   `asset/extensions/{name}/enabled`, `limits/*`).
8. Animation control ops (`animation/start|stop|stopAt`) incl. GLB binary-chunk
   accessor decoding, effective-timestamp wrapping, playhead/virtualPlayhead/
   isPlaying/minTime/maxTime virtual pointers, err flows for invalid inputs.
9. `pointer/interpolate` with cubic Bézier easing and quaternion slerp.
10. Delay references (`flow/setDelay` `lastDelay` ref socket, ref-based
    `flow/cancelDelay`, `/extensions/KHR_interactivity/delays/{}` validation).
11. Event references (`event` ref sockets on onStart/onTick/receive/send,
    `/extensions/KHR_interactivity/events/{}`, `event/stopPropagation`).
12. int32 two's-complement wrapping (`INT_MAX + 1`, `INT_MIN / -1`, `x / 0 = 0`).
13. New math ops: `cross`, `round` (half away from zero), `Tau`, `smoothStep`,
    vector `slerp`, `quatSlerp`, `quatFromAngles`, `rgbToOkLCh`, `rgbFromOkLCh`,
    2x2/3x3 matrix ops (`combine/extract/matMul/transpose/determinant/inverse`),
    polymorphic dispatch for `matMul/transpose/determinant/inverse`.
14. Fixed `clamp` operand order (lower bound wins), `rotate3D` (spec formula,
    unnormalized quaternion), `matDecompose` edge cases (bottom row ignored,
    translation always emitted, degenerate scales emitted with identity rotation),
    cubic Bézier easing now solves for the curve parameter (previously used input
    progress directly).
15. Object Model TRS defaults for nodes that omit translation/rotation/scale.
16. Test runner rewritten to the official protocol: run all `event/onStart` nodes
    in JSON order on one runtime, tick for the asset-advertised
    `expectedDuration`, judge by graph-computed `TestResult_HasPassed_*` booleans.

## Follow-ups

- Port the interactivity conformance fixes into the viewer's integrated runtime
  (`src/runtime/interactivity-runtime.ts`) or refactor the viewer to consume the
  package runtime (tracked as a task).
- Optional: implement `KHR_draco_mesh_compression` / meshopt decoding and
  `KHR_lights_punctual` rendering to close the remaining corpus gaps.
