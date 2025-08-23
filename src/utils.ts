// ============================================================================
// Utility Functions
// ============================================================================
import { readTextIfExists } from "./io.js";
import { StoredData } from "./fetch/types.js";
import { UpdateOptions, UpdateResult } from "./types.js";

/** Load existing file if present; otherwise return empty structure */
export async function loadExisting(
  path = "data/latest.json"
): Promise<StoredData> {
  const raw = await readTextIfExists(path);
  if (!raw) return { names: {}, shortNames: {} };
  const parsed = JSON.parse(raw);
  return {
    names: parsed.names ?? {},
    shortNames: parsed.shortNames ?? {},
  };
}

export function numberToBps(input: number | string): string {
  const bps = Math.round((Number(input) / 1e18) * 100);
  return bps.toString();
}

/** Sort object by keys for stable diffs */
export function sortRecord(
  rec: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rec).sort(([a], [b]) => a.localeCompare(b))
  );
}

// ============================================================================
// Data Merge Functions
// ============================================================================

/** Generic deep merge function that works with any type */
function deepMerge<T>(
  existing: T,
  incoming: Partial<T>,
  options: UpdateOptions = {},
  path: string[] = []
): { merged: T; added: number; updated: number } {
  const { appendOnly = false } = options;
  let added = 0;
  let updated = 0;

  // Handle null/undefined cases
  if (incoming == null) {
    return { merged: existing, added: 0, updated: 0 };
  }
  if (existing == null) {
    return { merged: incoming as T, added: 1, updated: 0 };
  }

  // Handle primitive types and arrays
  if (
    typeof existing !== "object" ||
    typeof incoming !== "object" ||
    Array.isArray(existing) ||
    Array.isArray(incoming)
  ) {
    if (!appendOnly && existing !== incoming) {
      return { merged: incoming as T, added: 0, updated: 1 };
    }
    return { merged: existing, added: 0, updated: 0 };
  }

  // Handle objects
  const merged = { ...existing } as T;

  for (const [key, value] of Object.entries(incoming)) {
    const currentPath = [...path, key];
    const existingValue = (existing as any)[key];
    const exists = key in (existing as any);

    if (!exists) {
      // New key - always add
      (merged as any)[key] = value;
      added++;
    } else if (
      typeof existingValue === "object" &&
      typeof value === "object" &&
      !Array.isArray(existingValue) &&
      !Array.isArray(value) &&
      existingValue !== null &&
      value !== null
    ) {
      // Recursive merge for nested objects
      const nestedResult = deepMerge(
        existingValue,
        value,
        options,
        currentPath
      );
      (merged as any)[key] = nestedResult.merged;
      added += nestedResult.added;
      updated += nestedResult.updated;
    } else if (!appendOnly && existingValue !== value) {
      // Update existing value (if not append-only)
      (merged as any)[key] = value;
      updated++;
    }
    // In append-only mode, existing values are preserved
  }

  return { merged, added, updated };
}

/** Merge data with configurable append-only behavior */
export function mergeData<T>(
  existing: T,
  incoming: Partial<T>,
  defaults: Partial<T> = {},
  options: UpdateOptions = {}
): UpdateResult<T> {
  // Apply defaults first
  const baseData = { ...defaults, ...existing } as T;

  // Then merge incoming data
  const result = deepMerge(baseData, incoming, options);

  // Sort records if they contain string-keyed objects (for stable diffs)
  const sortedData = sortObjectKeys(result.merged);

  return {
    data: sortedData,
    added: result.added,
    updated: result.updated,
    targetFile: "",
  };
}

/** Recursively sort object keys for stable diffs */
function sortObjectKeys<T>(obj: T): T {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }

  const sorted = {} as T;
  const entries = Object.entries(obj as any).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  for (const [key, value] of entries) {
    (sorted as any)[key] = sortObjectKeys(value);
  }

  return sorted;
}
