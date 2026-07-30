# Interactivity Runtime

Standalone KHR_interactivity runtime and test runner.

## How to run

From repo root:

```
npm --prefix packages/interactivity install
npm --prefix packages/interactivity run test
```

The runner uses the Khronos interactivity test assets cloned at
`external/glTF-Test-Assets-Interactivity` in the repo root (override with the
`INTERACTIVITY_TESTS_ROOT` environment variable).

The runner follows the official corpus protocol: each test graph is run once
(all `event/onStart` nodes fire in JSON order), the runtime is ticked for the
asset-advertised `expectedDuration`, and each sub-test is judged by the
`TestResult_HasPassed_*` boolean the graph computes itself.

## What it does

- Loads test assets described by `test-index.json` and `mathtests-index.json`.
- Executes the interactivity graph from each `*.glb`.
- Validates expected results defined in each test `*.json` file.

## Notes

- `src/runtime.ts` implements the KHR_interactivity runtime.
- `src/runner.ts` discovers and executes tests.
- `npm run test` builds then runs the test runner.
