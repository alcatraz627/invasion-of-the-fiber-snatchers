/**
 * Fiber Snatcher — React DevTools global hook loader.
 *
 * Importing this file in dev installs `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`
 * without requiring the browser extension. Required only if you want the tier-1
 * hook access; tier-2 (__reactFiber$) and tier-3 (window.__snatcher__) work
 * without this.
 *
 * Install in target: `npm i -D react-devtools-core`, then import this file
 * from your root layout behind a NODE_ENV check.
 */

if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("react-devtools-core");
}

export {};
