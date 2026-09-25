// Next.js compiles `typeof window` to "object" in client bundles, which also
// strips three.js' own worker guard around `window.__THREE__ = …`. Workers have
// no `window`, so alias it to the worker scope before three is evaluated.
// Import this first in any worker entry that pulls in three.
const scope = globalThis as unknown as { window?: unknown };
if (scope.window === undefined) scope.window = globalThis;

export {};
