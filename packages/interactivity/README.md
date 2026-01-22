# Interactivity Runtime

Standalone KHR_interactivity runtime and test runner.

## How to run

From repo root:

```
npm --prefix packages/interactivity install
npm --prefix packages/interactivity run test
```

The runner expects the Khronos interactivity test assets at:

```
E:\glTF-Test-Assets-Interactivity\Tests\Interactivity
```

## What it does

- Loads test assets described by `test-index.json` and `mathtests-index.json`.
- Executes the interactivity graph from each `*.glb`.
- Validates expected results defined in each test `*.json` file.

## Notes

- `src/runtime.ts` implements the KHR_interactivity runtime.
- `src/runner.ts` discovers and executes tests.
- `npm run test` builds then runs the test runner.
