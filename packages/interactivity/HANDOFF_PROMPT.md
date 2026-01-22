# Handoff Prompt: KHR_interactivity Runtime

You are a coding agent working in `E:\glTF-webgpu`.

## Goal
Finish the interactivity runtime in `packages/interactivity` so it passes all tests in the Khronos interactivity test assets.

## Spec (source of truth)
https://github.com/KhronosGroup/glTF/blob/interactivity/extensions/2.0/Khronos/KHR_interactivity/Specification.adoc#introduction-general

## Test assets (local)
`E:\glTF-Test-Assets-Interactivity\Tests\Interactivity`

Each test folder has:
- `*.glb` with the interactivity graph
- `*.json` with expected results

Example:
`E:\glTF-Test-Assets-Interactivity\Tests\Interactivity\flow\branch\branch.glb`
`E:\glTF-Test-Assets-Interactivity\Tests\Interactivity\flow\branch\branch.json`

## What exists already
- `packages/interactivity/src/runtime.ts`: runtime implementation
- `packages/interactivity/src/runner.ts`: test discovery and execution
- `packages/interactivity/README.md`: usage
- Root script: `npm run test:interactivity`

## Requirements
1. All tests pass when running:
   - `npm --prefix packages/interactivity run test`
2. The runtime must follow the spec exactly (flow/value semantics, socket ordering, pointer rules, events, variable handling, etc.).
3. Keep changes scoped to `packages/interactivity` (or minimal root script updates if needed).
4. Document any changes in `packages/interactivity/README.md` if needed.

## Acceptance criteria
- `npm --prefix packages/interactivity run test` exits with 0.
- The runner prints a pass summary with total count.

## Current test status (run 2026-01-21)
Command: `npm --prefix packages/interactivity run test`

Failing tests (7 total):
- `flow/branch`
  - True-Condition false-flow expected false got true
  - False-Condition true-flow expected false got true
- `flow/setDelay_and_cancelDelay`
  - setDelay [cancel] expected false got true
  - cancelDelay triggered expected false got true
- `flow/throttle`
  - Ignore [out] when error expected false got true
- `flow/while`
  - [body] flow when false expected false got true
- `pointer/get_set_morphtargets`
  - multiple failures around weights length/value/validity
- `math/matDecomp-Shear`
  - decomp.isValid and stability expected true got false
- `math/random`
  - Monte Carlo 1k/10k expected pi got 3.124/3.1556

## Spec-guided fixes (use interactivity spec as source of truth)
Reference file in repo: `tmp_interactivity_spec.adoc`

### flow/branch
- Spec: only one output flow is activated based on `condition`; node is stateless. Only `in` input flow should be handled. (`tmp_interactivity_spec.adoc:3032`)
- Action: confirm branch never activates both `true` and `false`. If failures persist, trace branch entry points in `branch.glb` to see if the false/true flow is being executed unexpectedly.

### flow/while
- Spec: evaluate `condition`; if true activate `loopBody` then self-activate `in`; if false activate `completed`. (`tmp_interactivity_spec.adoc:3114`)
- Action: ensure no `loopBody` activation when `condition` is false, and `completed` activates exactly once when loop terminates.

### flow/throttle
- Spec: error only if `duration` is NaN, infinite, negative, or not convertible to internal time type. `duration == 0` is valid. If error, activate `err` and skip `out`/state updates. (`tmp_interactivity_spec.adoc:3312`)
- Action: fix validation (avoid `<= 0`), and ensure `out` is never activated on error.

### flow/setDelay & flow/cancelDelay
- Spec: `setDelay` schedules a delayed activation with a unique `lastDelayIndex`, stored in graph- and node-level arrays; `cancel` cancels all activations scheduled by the node and sets `lastDelayIndex = -1`. (`tmp_interactivity_spec.adoc:3359`)
- Spec: `cancelDelay` removes the delay index from all arrays and cancels the scheduled activation if present, then activates `out`. Non-positive indices are no-ops. (`tmp_interactivity_spec.adoc:3407`)
- Action: ensure cancel removes from both global and per-node lists and does not trigger `done`.

### pointer/get_set_morphtargets
- Spec: JSON Pointer templates like `"/nodes/{N}/weights/{W}"` are valid; `"/nodes/{}/weights"` (float[]) is unsupported and must be invalid. (`tmp_interactivity_spec.adoc:3709`, `tmp_interactivity_spec.adoc:3784`)
- Action: implement `weights/{index}` and `weights/length` using glTF AOM semantics:
  - If node has no mesh: invalid.
  - If mesh has no morph targets: `weights.length == 0` (valid); `weights/0` invalid.
  - If mesh has morph targets and node.weights missing: implicit weights default to zeros; `weights.length == targetCount`, `weights/0 == 0`.
  - If node.weights present: use node.weights; if mesh.weights present and node.weights missing, use mesh.weights; node overrides mesh.

### math/matDecompose (Shear test)
- Spec: decomposable if row4 is [0,0,0,1] within threshold, column lengths finite/non-zero, and determinant of normalized 3x3 is close to 1 within an implementation-defined threshold. No orthogonality requirement. (`tmp_interactivity_spec.adoc:1804`)
- Action: relax determinant tolerance and avoid extra orthogonality checks so shear matrices pass.

### math/random
- Spec: output value must be initialized on first access; if no flow activations between accesses, it must stay the same. (`tmp_interactivity_spec.adoc:1051`)
- Action: keep caching semantics aligned to spec, and match deterministic PRNG expected by tests (implementation-defined). Instrument `random.glb` to infer the required PRNG/seed if necessary.

## Notes
- The runner uses `test-index.json` and `mathtests-index.json` inside the test assets folder.
- If you change path handling, keep it flexible but default to the current path.
- Tests are deterministic; if a test fails, align behavior to the spec.

Start by running the tests and iteratively fix failures. Keep the implementation simple and spec-accurate.
