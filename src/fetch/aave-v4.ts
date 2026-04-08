import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import {
  fetchAaveV4Configs,
  type AaveV4SpokesByChain,
  type AaveV4SpokeConfig,
} from "./aave/fetchV4Configs.js";
import {
  fetchAaveV4Reserves,
  type AaveV4ReserveDetail,
} from "./aave/fetchV4Reserves.js";
import { fetchAaveV4Oracles } from "./aave/fetchV4Oracles.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function isValidOracle(oracle: string | undefined): boolean {
  return (
    !!oracle && oracle !== "" && oracle !== "0x" && oracle !== ZERO_ADDR
  );
}

function isValidSource(source: string | undefined): boolean {
  return (
    !!source && source !== "" && source !== "0x" && source !== ZERO_ADDR
  );
}

function nonEmpty(s: unknown): string {
  return typeof s === "string" && s !== "" ? s : "";
}

function pickStr(...candidates: unknown[]): string {
  for (const c of candidates) {
    const v = nonEmpty(c);
    if (v) return v;
  }
  return "";
}

// ============================================================================
// New consolidated spokes file shape — see LENDER_METADATA_PLAN.md
// ============================================================================

export type SpokeReserveJson = {
  reserveId: number;
  assetId: number;
  underlying: string;
  hub: string;
};

export type SpokeJsonEntry = {
  spoke: string;
  oracle: string;
  label: string;
  dynamicConfigKeyMax: number;
  baseHubAttribution: string;
  reserves: SpokeReserveJson[];
};

export type SpokesJson = {
  [chainId: string]: { [spokeAddr: string]: SpokeJsonEntry };
};

// ============================================================================
// Merge helpers (operate on the new flat-by-chain shapes)
// ============================================================================

function mergeReserveRow(
  prev: SpokeReserveJson,
  next: SpokeReserveJson,
): SpokeReserveJson {
  return {
    reserveId: next.reserveId,
    assetId: next.assetId || prev.assetId,
    underlying: pickStr(next.underlying, prev.underlying),
    hub: pickStr(next.hub, prev.hub),
  };
}

function mergeSpokeEntry(
  prev: SpokeJsonEntry,
  next: SpokeJsonEntry,
): SpokeJsonEntry {
  // Reserves: union by reserveId
  const byId = new Map<number, SpokeReserveJson>();
  for (const r of prev.reserves) byId.set(r.reserveId, r);
  for (const r of next.reserves) {
    const existing = byId.get(r.reserveId);
    byId.set(r.reserveId, existing ? mergeReserveRow(existing, r) : r);
  }
  const reserves = [...byId.values()].sort((a, b) => a.reserveId - b.reserveId);

  // Don't let an RPC flake wipe a known oracle
  const oracle = isValidOracle(next.oracle)
    ? next.oracle
    : isValidOracle(prev.oracle)
      ? prev.oracle
      : next.oracle;

  return {
    spoke: next.spoke,
    oracle,
    label: pickStr(next.label, prev.label),
    dynamicConfigKeyMax: Math.max(
      prev.dynamicConfigKeyMax ?? 0,
      next.dynamicConfigKeyMax ?? 0,
    ),
    baseHubAttribution: pickStr(prev.baseHubAttribution, next.baseHubAttribution),
    reserves,
  };
}

/** Append-only merge for the new spokes file. */
export function mergeSpokesJson(oldData: SpokesJson, newData: SpokesJson): SpokesJson {
  const result: SpokesJson = {};
  const chains = new Set([
    ...Object.keys(oldData ?? {}),
    ...Object.keys(newData ?? {}),
  ]);
  for (const chain of chains) {
    result[chain] = {};
    const oldChain = oldData?.[chain] ?? {};
    const newChain = newData?.[chain] ?? {};
    const spokeAddrs = new Set([
      ...Object.keys(oldChain),
      ...Object.keys(newChain),
    ]);
    for (const spoke of spokeAddrs) {
      const o = oldChain[spoke];
      const n = newChain[spoke];
      if (o && n) result[chain][spoke] = mergeSpokeEntry(o, n);
      else result[chain][spoke] = (n ?? o)!;
    }
  }
  return result;
}

type OracleRow = {
  underlying: string;
  spoke: string;
  reserveId: number;
  oracle: string;
};

type OracleSourceRow = OracleRow & { decimals: number; source: string };

function mergeOracleRow<T extends OracleRow>(prev: T, next: T): T {
  const useNext = isValidOracle(next.oracle);
  const base = useNext ? { ...prev, ...next } : { ...next, ...prev };
  base.underlying = pickStr(next.underlying, prev.underlying, base.underlying);
  return base as T;
}

function mergeOracleSourceRow(
  prev: OracleSourceRow,
  next: OracleSourceRow,
): OracleSourceRow {
  const merged = mergeOracleRow(prev, next);
  const source = isValidSource(next.source)
    ? next.source.toLowerCase()
    : isValidSource(prev.source)
      ? prev.source.toLowerCase()
      : merged.source ?? "";
  return { ...merged, source };
}

/** Merge an array-of-rows oracle file by (spoke, reserveId). */
function mergeOracleArrayByChain<T extends OracleRow>(
  oldData: { [chain: string]: T[] },
  newData: { [chain: string]: T[] },
  rowMerger: (prev: T, next: T) => T,
): { [chain: string]: T[] } {
  const result: { [chain: string]: T[] } = {};
  const chains = new Set([
    ...Object.keys(oldData ?? {}),
    ...Object.keys(newData ?? {}),
  ]);
  for (const chain of chains) {
    const merged = new Map<string, T>();
    const key = (r: T) => `${r.spoke.toLowerCase()}|${r.reserveId}`;
    for (const r of oldData?.[chain] ?? []) {
      const k = key(r);
      const existing = merged.get(k);
      merged.set(k, existing ? rowMerger(existing, r) : r);
    }
    for (const r of newData?.[chain] ?? []) {
      const k = key(r);
      const existing = merged.get(k);
      merged.set(k, existing ? rowMerger(existing, r) : r);
    }
    result[chain] = [...merged.values()].sort(
      (a, b) =>
        a.spoke.localeCompare(b.spoke) || a.reserveId - b.reserveId,
    );
  }
  return result;
}

// ============================================================================
// Output file paths
// ============================================================================

const spokesFile = "./data/aave-v4-spokes.json";
const oraclesFile = "./data/aave-v4-oracles.json";
const oracleSourcesFile = "./data/aave-v4-oracle-sources.json";

// ============================================================================
// Updater
// ============================================================================

/**
 * Convert the in-memory spoke-config + reserve-detail maps into the
 * consolidated on-disk shape (reserves nested inside each spoke entry).
 */
function buildSpokesJson(
  configs: AaveV4SpokesByChain,
  reservesByChain: { [chainId: string]: { [spoke: string]: AaveV4ReserveDetail[] } },
  maxKeysByChain: { [chainId: string]: { [spoke: string]: number } },
): SpokesJson {
  const out: SpokesJson = {};
  for (const chain of Object.keys(configs)) {
    out[chain] = {};
    for (const spoke of Object.keys(configs[chain])) {
      const cfg: AaveV4SpokeConfig = configs[chain][spoke];
      const detailRows = reservesByChain[chain]?.[spoke] ?? [];
      const reserves: SpokeReserveJson[] = detailRows
        .map((d) => ({
          reserveId: d.reserveId,
          assetId: d.assetId,
          underlying: d.underlying,
          hub: d.hub,
        }))
        .sort((a, b) => a.reserveId - b.reserveId);

      out[chain][spoke] = {
        spoke,
        oracle: cfg.oracle,
        label: cfg.label,
        dynamicConfigKeyMax: maxKeysByChain[chain]?.[spoke] ?? 0,
        baseHubAttribution: cfg.baseHubAttribution,
        reserves,
      };
    }
  }
  return out;
}

export class AaveV4Updater implements DataUpdater {
  name = "Aave V4";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    // Step 1: Discover spokes from every hub seed
    const { spokes } = await fetchAaveV4Configs();

    // Step 2: Discover reserves per spoke (chain-scoped, no fork dim)
    const { reserves, maxDynamicConfigKeys } = await fetchAaveV4Reserves(
      spokes,
    );

    // Step 3: Discover oracle sources per (spoke, reserveId)
    const { oracles, sources } = await fetchAaveV4Oracles(spokes, reserves);

    // Assemble the consolidated spokes-with-reserves shape
    const spokesJson = buildSpokesJson(spokes, reserves, maxDynamicConfigKeys);

    return {
      [spokesFile]: spokesJson,
      [oraclesFile]: oracles,
      [oracleSourcesFile]: sources,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    if (fileKey === spokesFile) {
      return mergeSpokesJson(oldData ?? {}, data ?? {});
    }
    if (fileKey === oraclesFile) {
      return mergeOracleArrayByChain(oldData ?? {}, data ?? {}, mergeOracleRow);
    }
    if (fileKey === oracleSourcesFile) {
      return mergeOracleArrayByChain(
        oldData ?? {},
        data ?? {},
        mergeOracleSourceRow,
      );
    }
    return mergeData(oldData, data);
  }

  defaults = {};
}
