import { mergeData } from "../utils.js";
import { loadExisting } from "../utils.js";
import { fetchAaveV4Configs } from "./aave/fetchV4Configs.js";
import { fetchAaveV4Reserves } from "./aave/fetchV4Reserves.js";
import { fetchAaveV4Oracles } from "./aave/fetchV4Oracles.js";
function nonEmptyUnderlying(u) {
    return typeof u === "string" && u !== "" ? u : "";
}
/** Prefer first non-empty underlying (object spread can leave '' over a prior value). */
function pickUnderlying(a, b, fallback) {
    return (nonEmptyUnderlying(a) ||
        nonEmptyUnderlying(b) ||
        nonEmptyUnderlying(fallback) ||
        "");
}
/** Fold duplicate rows in persisted data (same spoke + reserveId). */
function mergeOracleLikeRows(prev, next) {
    let base;
    if (isValidOracle(next.oracle)) {
        base = { ...prev, ...next };
    }
    else if (isValidOracle(prev.oracle)) {
        base = { ...next, ...prev };
    }
    else {
        base = { ...prev, ...next };
    }
    const underlying = pickUnderlying(prev.underlying, next.underlying, base.underlying);
    return { ...base, underlying };
}
/** Apply a newly fetched row onto an existing merged row. */
function applyIncomingOracleRow(existing, incoming) {
    if (isValidOracle(incoming.oracle)) {
        const merged = { ...existing, ...incoming };
        const underlying = pickUnderlying(existing.underlying, incoming.underlying, merged.underlying);
        return { ...merged, underlying };
    }
    const underlying = pickUnderlying(existing.underlying, incoming.underlying);
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
export function mergeArrayData(oldData, newData) {
    const result = {};
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
            const oldArr = oldData?.[fork]?.[chain] ?? [];
            const newArr = newData?.[fork]?.[chain] ?? [];
            const entryKey = (e) => `${String(e.spoke).toLowerCase()}|${Number(e.reserveId)}`;
            const merged = new Map();
            for (const entry of oldArr) {
                const key = entryKey(entry);
                const existing = merged.get(key);
                merged.set(key, existing ? mergeOracleLikeRows(existing, entry) : entry);
            }
            for (const entry of newArr) {
                const key = entryKey(entry);
                const existing = merged.get(key);
                if (!existing) {
                    merged.set(key, entry);
                }
                else {
                    merged.set(key, applyIncomingOracleRow(existing, entry));
                }
            }
            result[fork][chain] = [...merged.values()].sort((a, b) => a.spoke.localeCompare(b.spoke) || a.reserveId - b.reserveId);
        }
    }
    return result;
}
function isValidSource(source) {
    return (!!source &&
        source !== "" &&
        source !== "0x" &&
        source !== "0x0000000000000000000000000000000000000000");
}
/** Fold duplicate rows; prefer a valid price source address when one side has it. */
function mergeOracleSourcesLikeRows(prev, next) {
    const base = mergeOracleLikeRows(prev, next);
    const source = isValidSource(next.source)
        ? String(next.source).toLowerCase()
        : isValidSource(prev.source)
            ? String(prev.source).toLowerCase()
            : typeof base.source === "string"
                ? base.source
                : "";
    return { ...base, source };
}
/** Like applyIncomingOracleRow, but do not wipe a good source when the fetch returned empty (multicall flake). */
function applyIncomingOracleSourceRow(existing, incoming) {
    if (isValidOracle(incoming.oracle)) {
        const merged = { ...existing, ...incoming };
        const underlying = pickUnderlying(existing.underlying, incoming.underlying, merged.underlying);
        const source = isValidSource(incoming.source)
            ? String(incoming.source).toLowerCase()
            : isValidSource(existing.source)
                ? String(existing.source).toLowerCase()
                : typeof merged.source === "string"
                    ? merged.source
                    : "";
        return { ...merged, underlying, source };
    }
    const underlying = pickUnderlying(existing.underlying, incoming.underlying);
    return {
        ...existing,
        underlying: underlying || existing.underlying || "",
    };
}
/**
 * Same as mergeArrayData for aave-v4-oracle-sources.json: merges by (spoke, reserveId)
 * and preserves non-empty source when a new fetch has empty source (RPC/multicall failure).
 */
export function mergeOracleSourcesArrayData(oldData, newData) {
    const result = {};
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
            const oldArr = oldData?.[fork]?.[chain] ?? [];
            const newArr = newData?.[fork]?.[chain] ?? [];
            const entryKey = (e) => `${String(e.spoke).toLowerCase()}|${Number(e.reserveId)}`;
            const merged = new Map();
            for (const entry of oldArr) {
                const key = entryKey(entry);
                const existing = merged.get(key);
                merged.set(key, existing ? mergeOracleSourcesLikeRows(existing, entry) : entry);
            }
            for (const entry of newArr) {
                const key = entryKey(entry);
                const existing = merged.get(key);
                if (!existing) {
                    merged.set(key, entry);
                }
                else {
                    merged.set(key, applyIncomingOracleSourceRow(existing, entry));
                }
            }
            result[fork][chain] = [...merged.values()].sort((a, b) => a.spoke.localeCompare(b.spoke) || a.reserveId - b.reserveId);
        }
    }
    return result;
}
function isValidOracle(oracle) {
    return (!!oracle &&
        oracle !== "" &&
        oracle !== "0x" &&
        oracle !== "0x0000000000000000000000000000000000000000");
}
/** Merge one reserve detail row; keep non-empty address fields and stable dynamic config. */
function mergeReserveDetailRow(prev, next) {
    const merged = { ...prev, ...next };
    merged.underlying = pickUnderlying(prev.underlying, next.underlying, merged.underlying);
    merged.hub = pickUnderlying(prev.hub, next.hub, merged.hub);
    if (next.latestDynamicConfig == null && prev.latestDynamicConfig != null) {
        merged.latestDynamicConfig = prev.latestDynamicConfig;
    }
    return merged;
}
/**
 * Merge reserve detail arrays per spoke by reserveId.
 * Avoids generic deepMerge replacing whole arrays and losing prior underlying/hub when RPC flakes.
 */
export function mergeReserveDetailsData(oldData, newData) {
    const result = {};
    const forks = new Set([
        ...Object.keys(oldData ?? {}),
        ...Object.keys(newData ?? {}),
    ]);
    for (const fork of forks) {
        result[fork] = {};
        const chains = new Set([
            ...Object.keys(oldData?.[fork] ?? {}),
            ...Object.keys(newData?.[fork] ?? {}),
        ]);
        for (const chain of chains) {
            result[fork][chain] = {};
            const oldSpokes = oldData?.[fork]?.[chain] ?? {};
            const newSpokes = newData?.[fork]?.[chain] ?? {};
            const spokeAddrs = new Set([
                ...Object.keys(oldSpokes),
                ...Object.keys(newSpokes),
            ]);
            for (const spoke of spokeAddrs) {
                const oldArr = oldSpokes[spoke] ?? [];
                const newArr = newSpokes[spoke] ?? [];
                const byReserveId = new Map();
                for (const row of oldArr) {
                    byReserveId.set(Number(row.reserveId), row);
                }
                for (const row of newArr) {
                    const id = Number(row.reserveId);
                    const existing = byReserveId.get(id);
                    byReserveId.set(id, existing ? mergeReserveDetailRow(existing, row) : row);
                }
                result[fork][chain][spoke] = [...byReserveId.values()].sort((a, b) => a.reserveId - b.reserveId);
            }
        }
    }
    return result;
}
/** Fill empty underlying in details from oracle rows (same fork/chain/spoke/reserveId). */
export function backfillReserveDetailsFromOracles(details, oracles) {
    const out = JSON.parse(JSON.stringify(details));
    for (const fork of Object.keys(oracles ?? {})) {
        const oracleChains = oracles[fork] ?? {};
        for (const chain of Object.keys(oracleChains)) {
            const rows = oracleChains[chain] ?? [];
            const byKey = new Map();
            for (const r of rows) {
                const u = nonEmptyUnderlying(r.underlying);
                if (!u)
                    continue;
                byKey.set(`${String(r.spoke).toLowerCase()}|${Number(r.reserveId)}`, u);
            }
            const detailChains = out[fork]?.[chain];
            if (!detailChains)
                continue;
            for (const spoke of Object.keys(detailChains)) {
                const arr = detailChains[spoke] ?? [];
                for (const row of arr) {
                    if (nonEmptyUnderlying(row.underlying))
                        continue;
                    const u = byKey.get(`${spoke.toLowerCase()}|${Number(row.reserveId)}`);
                    if (u)
                        row.underlying = u;
                }
            }
        }
    }
    return out;
}
/** Fill empty `hub` on reserve rows from `aave-v4-hubs.json`-shaped seed (one hub per fork/chain). */
export function backfillReserveDetailsHubFromConfig(details, hubSeed) {
    const out = JSON.parse(JSON.stringify(details));
    for (const fork of Object.keys(out ?? {})) {
        for (const chain of Object.keys(out[fork] ?? {})) {
            const configured = nonEmptyUnderlying(hubSeed?.[fork]?.[chain]?.hub);
            if (!configured)
                continue;
            const hubLower = configured.toLowerCase();
            const spokeMap = out[fork][chain] ?? {};
            for (const spoke of Object.keys(spokeMap)) {
                const arr = spokeMap[spoke] ?? [];
                for (const row of arr) {
                    if (nonEmptyUnderlying(row.hub))
                        continue;
                    row.hub = hubLower;
                }
            }
        }
    }
    return out;
}
/** Dedupe-merge persisted details, then oracle underlying backfill, then hub from config. */
export function normalizeReserveDetailsPersisted(details, { oracles, hubSeed }) {
    let d = mergeReserveDetailsData(details, {});
    d = backfillReserveDetailsFromOracles(d, oracles);
    d = backfillReserveDetailsHubFromConfig(d, hubSeed);
    return d;
}
/**
 * Append-only merge for spokes data.
 * Deduplicates by spoke address within each fork/chain.
 * Never overwrites a valid oracle with "0x".
 */
function mergeSpokesData(oldData, newData) {
    const result = {};
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
            const oldArr = oldData?.[fork]?.[chain] ?? [];
            const newArr = newData?.[fork]?.[chain] ?? [];
            const merged = new Map();
            for (const entry of oldArr) {
                merged.set(entry.spoke, entry);
            }
            for (const entry of newArr) {
                const existing = merged.get(entry.spoke);
                if (!existing) {
                    merged.set(entry.spoke, entry);
                }
                else {
                    // Update fields, but protect oracle from being wiped
                    const updated = { ...existing, ...entry };
                    if (isValidOracle(existing.oracle) && !isValidOracle(entry.oracle)) {
                        updated.oracle = existing.oracle;
                    }
                    merged.set(entry.spoke, updated);
                }
            }
            result[fork][chain] = [...merged.values()].sort((a, b) => a.spoke.localeCompare(b.spoke));
        }
    }
    return result;
}
const hubsFile = "./config/aave-v4-hubs.json";
const spokesFile = "./data/aave-v4-spokes.json";
const reservesFile = "./data/aave-v4-reserves.json";
const reserveDetailsFile = "./data/aave-v4-reserve-details.json";
const oraclesFile = "./data/aave-v4-oracles.json";
const oracleSourcesFile = "./data/aave-v4-oracle-sources.json";
export class AaveV4Updater {
    name = "Aave V4";
    async fetchData() {
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
    mergeData(oldData, data, fileKey) {
        if (fileKey === spokesFile) {
            return mergeSpokesData(oldData, data);
        }
        if (fileKey === oracleSourcesFile) {
            return mergeOracleSourcesArrayData(oldData, data);
        }
        if (fileKey === oraclesFile) {
            return mergeArrayData(oldData, data);
        }
        if (fileKey === reserveDetailsFile) {
            return mergeReserveDetailsData(oldData, data);
        }
        return mergeData(oldData, data);
    }
    defaults = {};
}
