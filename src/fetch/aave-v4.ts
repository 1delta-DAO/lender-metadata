import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { loadExisting } from "../utils.js";
import { fetchAaveV4Configs } from "./aave/fetchV4Configs.js";
import { fetchAaveV4Reserves } from "./aave/fetchV4Reserves.js";
import { fetchAaveV4Oracles } from "./aave/fetchV4Oracles.js";

function nonEmptyUnderlying(u: unknown): string {
  return typeof u === "string" && u !== "" ? u : "";
}

/** Prefer first non-empty underlying (object spread can leave '' over a prior value). */
function pickUnderlying(
  a: unknown,
  b: unknown,
  fallback?: unknown,
): string {
  return (
    nonEmptyUnderlying(a) ||
    nonEmptyUnderlying(b) ||
    nonEmptyUnderlying(fallback) ||
    ""
  );
}

/** Fold duplicate rows in persisted data (same spoke + reserveId). */
function mergeOracleLikeRows(prev: any, next: any): any {
  let base: any;
  if (isValidOracle(next.oracle)) {
    base = { ...prev, ...next };
  } else if (isValidOracle(prev.oracle)) {
    base = { ...next, ...prev };
  } else {
    base = { ...prev, ...next };
  }
  const underlying = pickUnderlying(
    prev.underlying,
    next.underlying,
    base.underlying,
  );
  return { ...base, underlying };
}

/** Apply a newly fetched row onto an existing merged row. */
function applyIncomingOracleRow(existing: any, incoming: any): any {
  if (isValidOracle(incoming.oracle)) {
    const merged = { ...existing, ...incoming };
    const underlying = pickUnderlying(
      existing.underlying,
      incoming.underlying,
      merged.underlying,
    );
    return { ...merged, underlying };
  }
  const underlying = pickUnderlying(
    existing.underlying,
    incoming.underlying,
  );
  return {
    ...existing,
    underlying: underlying || existing.underlying || "",
  };
}

/**
 * Append-only merge for array-based oracle data.
 * Matches entries by (spoke, reserveId); underlying is merged, not part of the key.
 * New entries are added; existing entries are updated only if the
 * incoming entry has a non-empty oracle (avoids RPC failures wiping data).
 */
export function mergeArrayData(oldData: any, newData: any): any {
  const result: any = {};

  const allForks = new Set([
    ...Object.keys(oldData ?? {}),
    ...Object.keys(newData ?? {}),
  ]);

  for (const fork of allForks) {
    result[fork] = {};
    const allChains = new Set([
      ...Object.keys(oldData?.[fork] ?? {}),
      ...Object.keys(newData?.[fork] ?? {}),
    ]);

    for (const chain of allChains) {
      const oldArr: any[] = oldData?.[fork]?.[chain] ?? [];
      const newArr: any[] = newData?.[fork]?.[chain] ?? [];

      const entryKey = (e: any) =>
        `${String(e.spoke).toLowerCase()}|${Number(e.reserveId)}`;

      const merged = new Map<string, any>();
      for (const entry of oldArr) {
        const key = entryKey(entry);
        const existing = merged.get(key);
        merged.set(
          key,
          existing ? mergeOracleLikeRows(existing, entry) : entry,
        );
      }

      for (const entry of newArr) {
        const key = entryKey(entry);
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, entry);
        } else {
          merged.set(key, applyIncomingOracleRow(existing, entry));
        }
      }

      result[fork][chain] = [...merged.values()].sort(
        (a, b) =>
          a.spoke.localeCompare(b.spoke) || a.reserveId - b.reserveId,
      );
    }
  }

  return result;
}

function isValidOracle(oracle: string | undefined): boolean {
  return (
    !!oracle &&
    oracle !== '' &&
    oracle !== '0x' &&
    oracle !== '0x0000000000000000000000000000000000000000'
  )
}

/**
 * Append-only merge for spokes data.
 * Deduplicates by spoke address within each fork/chain.
 * Never overwrites a valid oracle with "0x".
 */
function mergeSpokesData(oldData: any, newData: any): any {
  const result: any = {}

  const allForks = new Set([
    ...Object.keys(oldData ?? {}),
    ...Object.keys(newData ?? {}),
  ])

  for (const fork of allForks) {
    result[fork] = {}
    const allChains = new Set([
      ...Object.keys(oldData?.[fork] ?? {}),
      ...Object.keys(newData?.[fork] ?? {}),
    ])

    for (const chain of allChains) {
      const oldArr: any[] = oldData?.[fork]?.[chain] ?? []
      const newArr: any[] = newData?.[fork]?.[chain] ?? []

      const merged = new Map<string, any>()
      for (const entry of oldArr) {
        merged.set(entry.spoke, entry)
      }

      for (const entry of newArr) {
        const existing = merged.get(entry.spoke)
        if (!existing) {
          merged.set(entry.spoke, entry)
        } else {
          // Update fields, but protect oracle from being wiped
          const updated = { ...existing, ...entry }
          if (isValidOracle(existing.oracle) && !isValidOracle(entry.oracle)) {
            updated.oracle = existing.oracle
          }
          merged.set(entry.spoke, updated)
        }
      }

      result[fork][chain] = [...merged.values()].sort((a, b) =>
        a.spoke.localeCompare(b.spoke),
      )
    }
  }

  return result
}

const hubsFile = "./config/aave-v4-hubs.json";
const spokesFile = "./data/aave-v4-spokes.json";
const reservesFile = "./data/aave-v4-reserves.json";
const reserveDetailsFile = "./data/aave-v4-reserve-details.json";
const oraclesFile = "./data/aave-v4-oracles.json";
const oracleSourcesFile = "./data/aave-v4-oracle-sources.json";

export class AaveV4Updater implements DataUpdater {
  name = "Aave V4";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    // Load hub seed config
    const hubSeed = await loadExisting(hubsFile);

    // Step 1: Discover hubs & spokes
    const { spokes } = await fetchAaveV4Configs(hubSeed);

    // Step 2: Discover reserves
    const { reserves, details, maxDynamicConfigKeys } = await fetchAaveV4Reserves(spokes);

    // Enrich spokes with maxDynamicConfigKey per spoke
    for (const fork of Object.keys(spokes)) {
      for (const chain of Object.keys(spokes[fork])) {
        for (const entry of spokes[fork][chain]) {
          entry.dynamicConfigKeyMax =
            maxDynamicConfigKeys[fork]?.[chain]?.[entry.spoke] ?? 0;
        }
      }
    }

    // Step 3: Discover oracles
    const { oracles, sources } = await fetchAaveV4Oracles(spokes, reserves, details);

    return {
      [spokesFile]: spokes,
      [reservesFile]: reserves,
      [reserveDetailsFile]: details,
      [oraclesFile]: oracles,
      [oracleSourcesFile]: sources,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    if (fileKey === spokesFile) {
      return mergeSpokesData(oldData, data);
    }
    if (fileKey === oraclesFile || fileKey === oracleSourcesFile) {
      return mergeArrayData(oldData, data);
    }
    return mergeData(oldData, data);
  }

  defaults = {};
}
