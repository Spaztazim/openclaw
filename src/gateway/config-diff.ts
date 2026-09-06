// Config path diff helper used by gateway mutation diagnostics.
import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "../utils.js";

/** Return dotted config paths whose values differ between two config snapshots. */
export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  const paths = diffConfigValuePaths(prev, next, prefix);
  if (prefix || paths.length === 0) {
    return paths;
  }
  const entries = (value: unknown): Record<string, unknown> => {
    if (
      !isPlainObject(value) ||
      !isPlainObject(value.plugins) ||
      !isPlainObject(value.plugins.entries)
    ) {
      return {};
    }
    return value.plugins.entries;
  };
  const before = entries(prev),
    after = entries(next);
  const grants = (entry: unknown) =>
    isPlainObject(entry) && isPlainObject(entry.grants) ? entry.grants.boundChat : undefined;
  // A whole entry/plugins deletion otherwise collapses to an ancestor hot path.
  // Preserve the authority delta so restart policy cannot be bypassed by shape changes.
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const grantPath = `plugins.entries.${id}.grants.boundChat`;
    if (!isDeepStrictEqual(grants(before[id]), grants(after[id])) && !paths.includes(grantPath)) {
      paths.push(grantPath);
    }
  }
  return paths;
}

function diffConfigValuePaths(prev: unknown, next: unknown, prefix: string): string[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigValuePaths(prevValue, nextValue, childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example memory.qmd.paths/scope.rules);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [prefix || "<root>"];
}
