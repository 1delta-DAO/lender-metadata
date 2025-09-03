// ============================================================================
// Utility Functions
// ============================================================================
import { readTextIfExists } from "./io.js";
/** Load existing file if present; otherwise return empty structure */
export async function loadExisting(path = "data/latest.json") {
    const raw = await readTextIfExists(path);
    if (!raw)
        return { names: {}, shortNames: {} };
    const parsed = JSON.parse(raw);
    return {
        names: parsed.names ?? {},
        shortNames: parsed.shortNames ?? {},
    };
}
export function numberToBps(input) {
    const bps = Math.round((Number(input) / 1e18) * 100);
    return bps.toString();
}
/** Sort object by keys for stable diffs */
export function sortRecord(rec) {
    return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
}
// ============================================================================
// Data Merge Functions
// ============================================================================
/** Generic deep merge function that works with any type */
function deepMerge(existing, incoming, options = {}, path = []) {
    const { appendOnly = false } = options;
    let added = 0;
    let updated = 0;
    // Handle null/undefined cases
    if (incoming == null) {
        return { merged: existing, added: 0, updated: 0 };
    }
    if (existing == null) {
        return { merged: incoming, added: 1, updated: 0 };
    }
    // Handle primitive types and arrays
    if (typeof existing !== "object" ||
        typeof incoming !== "object" ||
        Array.isArray(existing) ||
        Array.isArray(incoming)) {
        if (!appendOnly && existing !== incoming) {
            return { merged: incoming, added: 0, updated: 1 };
        }
        return { merged: existing, added: 0, updated: 0 };
    }
    // Handle objects
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
        const currentPath = [...path, key];
        const existingValue = existing[key];
        const exists = key in existing;
        if (!exists) {
            // New key - always add
            merged[key] = value;
            added++;
        }
        else if (typeof existingValue === "object" &&
            typeof value === "object" &&
            !Array.isArray(existingValue) &&
            !Array.isArray(value) &&
            existingValue !== null &&
            value !== null) {
            // Recursive merge for nested objects
            const nestedResult = deepMerge(existingValue, value, options, currentPath);
            merged[key] = nestedResult.merged;
            added += nestedResult.added;
            updated += nestedResult.updated;
        }
        else if (!appendOnly && existingValue !== value) {
            // Update existing value (if not append-only)
            merged[key] = value;
            updated++;
        }
        // In append-only mode, existing values are preserved
    }
    return { merged, added, updated };
}
/** Merge data with configurable append-only behavior */
export function mergeData(existing, incoming, defaults = {}, options = {}) {
    // Apply defaults first
    const baseData = { ...defaults, ...existing };
    // Then merge incoming data
    const result = deepMerge(baseData, incoming, options);
    // Sort records if they contain string-keyed objects (for stable diffs)
    const sortedData = sortObjectKeys(result.merged);
    return sortedData;
}
/** Recursively sort object keys for stable diffs */
function sortObjectKeys(obj) {
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
        return obj;
    }
    const sorted = {};
    const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of entries) {
        sorted[key] = sortObjectKeys(value);
    }
    return sorted;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
