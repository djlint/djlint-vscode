import { isDeepStrictEqual } from "node:util";

/** Scope key for a cached value: a stringified `vscode.Uri`, or `undefined`
for the workspace-wide scope. Kept as a plain string (rather than taking a
`vscode.Uri` directly) so this cache has no dependency on `vscode` and stays
unit-testable on its own. */
export type EnvironmentCacheKey = string | undefined;

export interface EnvironmentChangeCache<T> {
  /** Store `value` for `key`, returning `true` only if it differs
  (deep-equality) from whatever was previously stored for that key. Used to
  drop duplicate change events that report no actual change. */
  record: (key: EnvironmentCacheKey, value: T) => boolean;

  /** Store `value` for `key` without reporting whether it changed. */
  remember: (key: EnvironmentCacheKey, value: T) => void;
}

const workspaceKey = Symbol("workspace");

function scopeKey(key: EnvironmentCacheKey): string | typeof workspaceKey {
  return key ?? workspaceKey;
}

/** A small per-scope cache of the last-seen value, used to de-duplicate
change-event notifications that report no actual change. */
export function createEnvironmentChangeCache<
  T,
>(): EnvironmentChangeCache<T> {
  const values = new Map<string | typeof workspaceKey, T>();

  return {
    record(key, value): boolean {
      const mapKey = scopeKey(key);
      const isUnchanged = isDeepStrictEqual(values.get(mapKey), value);
      values.set(mapKey, value);
      return !isUnchanged;
    },
    remember(key, value): void {
      values.set(scopeKey(key), value);
    },
  };
}
