/**
 * Browser shims for Node globals that dependencies expect.
 *
 * Imported first by `main.tsx`. It has to live in its own module: ES modules
 * evaluate all of their imports before the importing module's body runs, so
 * assignments written directly in `main.tsx` would land after the dependency
 * graph has already been evaluated — too late for anything that reads these
 * globals at module scope.
 */

import { Buffer } from "buffer";

type NodeGlobals = {
  Buffer?: typeof Buffer;
  process?: { env: Record<string, string | undefined> };
};

// Cast through `unknown`: @types/node reaches this file through the `buffer`
// package, so `globalThis.process` is typed as the full Node `Process`.
const globals = globalThis as unknown as NodeGlobals;

// `@solana/web3.js` v1 and its dependencies expect Node's Buffer.
globals.Buffer ??= Buffer;

// The Codama-generated error map is guarded by `process.env["NODE_ENV"]`, read
// at module scope. Vite only substitutes the dot form of that expression, so
// without this the bare `process` throws "process is not defined" on import.
// `import.meta.env` is only injected by Vite, so it is guarded for the case
// where this module is loaded outside a Vite build (tests, tooling) — there a
// real `process` exists and the assignment is skipped anyway.
globals.process ??= { env: { NODE_ENV: import.meta.env?.MODE ?? "development" } };
