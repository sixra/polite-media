/**
 * Environment gates: the conditions under which video is allowed to play at all.
 * The poster is a complete fallback for every one of them, so a gate that says no
 * costs the user nothing.
 */

const queries = new Map<string, MediaQueryList>();

/**
 * Memoised `matchMedia`, and the reason every media query in this package goes
 * through one function: a module-scope `matchMedia(...)` throws the moment the
 * package is imported anywhere without a DOM (SSR, prerender, a Node test), and
 * would contradict the `sideEffects` declaration in package.json.
 *
 * Memoising also lets callers attach `change` listeners to the same object the
 * predicates read, so "honour it live" costs no extra plumbing.
 */
export function mediaQuery(query: string): MediaQueryList {
  let mql = queries.get(query);
  if (!mql) {
    mql = matchMedia(query);
    queries.set(query, mql);
  }
  return mql;
}

export function motionAllowed(): boolean {
  return !mediaQuery('(prefers-reduced-motion: reduce)').matches;
}

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * Video is an enhancement over a poster that already stands on its own, so it is
 * skipped on a metered or very slow connection.
 *
 * Absence must mean *allow*. The Network Information API is not Baseline: Safari
 * and Firefox never expose it, and Brave disables it as a fingerprinting surface.
 * Reading absence as "block" would fail closed for most of the web, and fail
 * closed in the one direction nobody would catch: Chrome is the browser that has
 * the API, so a Chrome-only developer never sees it.
 */
export function connectionAllowsMedia(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  return conn.effectiveType !== 'slow-2g' && conn.effectiveType !== '2g';
}

/** Drops memoised queries so a test can swap `matchMedia`. Not part of the public API. */
export function resetEnv(): void {
  queries.clear();
}
