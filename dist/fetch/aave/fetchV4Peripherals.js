import { sleep } from "../../utils.js";
import { AAVE_V4_HUB_SEED } from "./v4Hubs.js";
export const DEFAULT_GRAPHQL_URL = "https://api.aave.com/graphql";
/** Drop keys whose value is empty, so absent stays absent in the JSON. */
function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === "")
            continue;
        if (typeof v === "object" && v !== null && Object.keys(v).length === 0)
            continue;
        out[k] = v;
    }
    return out;
}
/** Stable key ordering for JSON diffs */
export function sortPeripheralsTree(data) {
    const out = {};
    const chainKeys = Object.keys(data ?? {}).sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb)
            return na - nb;
        return a.localeCompare(b);
    });
    for (const chain of chainKeys) {
        const c = data[chain];
        if (!c)
            continue;
        const perHub = {};
        for (const hk of Object.keys(c.perHub ?? {}).sort()) {
            const g = compact({ ...(c.perHub?.[hk] ?? {}) });
            if (Object.keys(g).length > 0)
                perHub[hk] = g;
        }
        const perSpoke = {};
        for (const sk of Object.keys(c.perSpoke ?? {}).sort()) {
            perSpoke[sk] = c.perSpoke[sk];
        }
        out[chain] = compact({
            nativeGateway: c.nativeGateway,
            signatureGateway: c.signatureGateway,
            perHub,
            perSpoke,
        });
    }
    return out;
}
const ZERO = "0x0000000000000000000000000000000000000000";
function normAddr(a) {
    return a.toLowerCase();
}
function isValidAddr(a) {
    if (!a || typeof a !== "string")
        return false;
    const x = a.toLowerCase();
    return x.length === 42 && x.startsWith("0x") && x !== ZERO;
}
/**
 * Keep a known gateway rather than let a partial fetch blank it, but return
 * `undefined` — not `""` — when neither side has one. See `ChainPeripherals`.
 */
function pickGateway(incoming, existing) {
    if (isValidAddr(incoming))
        return normAddr(incoming);
    if (isValidAddr(existing))
        return normAddr(existing);
    return undefined;
}
/**
 * A name the API supplies that carries no information. Aave's GraphQL returns
 * "Unknown" for every Giver/Taker/Config PM, so it must never overwrite the
 * curated name `update:aave-v4-pm-names` derives from the deployed bytecode.
 */
function isPlaceholderName(name) {
    const n = (name ?? "").trim();
    return n === "" || n.toLowerCase() === "unknown";
}
/**
 * Merge PM rows by lowercase address; incoming fields win on conflict, EXCEPT
 * a placeholder `name`, which never displaces a name already on record.
 */
export function mergePositionManagerLists(prev, next) {
    const merged = new Map();
    for (const p of prev) {
        const k = normAddr(p.address);
        merged.set(k, { ...p, address: k });
    }
    for (const n of next) {
        const k = normAddr(n.address);
        const existing = merged.get(k);
        if (!existing) {
            merged.set(k, { ...n, address: k });
            continue;
        }
        merged.set(k, {
            ...existing,
            ...n,
            address: k,
            name: isPlaceholderName(n.name) && !isPlaceholderName(existing.name) ? existing.name : n.name,
        });
    }
    return [...merged.values()].sort((a, b) => a.address.localeCompare(b.address));
}
function mergeSpokeEntry(prev, next) {
    if (!prev)
        return next;
    return {
        spokeName: next.spokeName || prev.spokeName,
        spokeId: next.spokeId || prev.spokeId,
        positionManagers: mergePositionManagerLists(prev.positionManagers, next.positionManagers),
    };
}
function mergeHubGateways(prev, next) {
    return compact({
        nativeGateway: pickGateway(next?.nativeGateway, prev?.nativeGateway),
        signatureGateway: pickGateway(next?.signatureGateway, prev?.signatureGateway),
    });
}
/**
 * Deep merge for persisted peripherals: preserves prior gateways/spokes when a
 * fetch is partial.
 *
 * APPEND-ONLY, and that is load-bearing. Aave's GraphQL API only knows the
 * hubs Aave itself operates, so a whitelabel instance (ether.fi on OP) fetches
 * as an empty chain; and `positionManagers[].name` is overwritten downstream by
 * `update:aave-v4-pm-names`, which classifies by bytecode. Neither may be
 * clobbered by an empty round.
 */
export function mergeAaveV4PeripheralsData(oldData, newData) {
    const chains = new Set([...Object.keys(oldData ?? {}), ...Object.keys(newData ?? {})]);
    const result = {};
    for (const chain of chains) {
        const o = oldData?.[chain];
        const n = newData?.[chain];
        if (!o && !n)
            continue;
        const perHub = {};
        for (const hub of new Set([...Object.keys(o?.perHub ?? {}), ...Object.keys(n?.perHub ?? {})])) {
            const merged = mergeHubGateways(o?.perHub?.[hub], n?.perHub?.[hub]);
            if (Object.keys(merged).length > 0)
                perHub[hub] = merged;
        }
        const perSpoke = { ...(o?.perSpoke ?? {}) };
        for (const [addr, spoke] of Object.entries(n?.perSpoke ?? {})) {
            perSpoke[addr] = mergeSpokeEntry(perSpoke[addr], spoke);
        }
        result[chain] = {
            nativeGateway: pickGateway(n?.nativeGateway, o?.nativeGateway),
            signatureGateway: pickGateway(n?.signatureGateway, o?.signatureGateway),
            perHub,
            perSpoke,
        };
    }
    return sortPeripheralsTree(result);
}
export async function aaveGql(url, query, variables, fetchFn) {
    const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
        throw new Error(`GraphQL HTTP ${res.status}`);
    }
    const json = (await res.json());
    if (json.errors?.length) {
        throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    if (json.data == null) {
        throw new Error("GraphQL response missing data");
    }
    return json.data;
}
const CHAINS_QUERY = `
query Chains($chainIds: [ChainId!]!) {
  chains(request: { query: { chainIds: $chainIds } }) {
    chainId
    nativeGateway
    signatureGateway
  }
}
`;
export const SPOKES_QUERY = `
query Spokes($hub: EvmAddress!, $chainId: ChainId!) {
  spokes(request: { query: { hub: { address: $hub, chainId: $chainId } } }) {
    id
    address
    name
    chain { chainId }
  }
}
`;
const PM_QUERY = `
query SpokePM($spoke: SpokeId!, $pageSize: PageSize!, $cursor: Cursor) {
  spokePositionManagers(request: { spoke: $spoke, pageSize: $pageSize, cursor: $cursor }) {
    items {
      name
      address
      active
    }
    pageInfo {
      next
    }
  }
}
`;
export async function fetchAllPositionManagersForSpoke(graphqlUrl, fetchFn, spokeId, throttleMs) {
    const all = [];
    let cursor;
    for (;;) {
        const data = await aaveGql(graphqlUrl, PM_QUERY, {
            spoke: spokeId,
            pageSize: "FIFTY",
            cursor: cursor ?? null,
        }, fetchFn);
        const items = data.spokePositionManagers?.items ?? [];
        for (const it of items) {
            all.push({
                name: String(it.name ?? ""),
                address: normAddr(it.address),
                active: Boolean(it.active),
            });
        }
        cursor = data.spokePositionManagers?.pageInfo?.next ?? null;
        if (!cursor)
            break;
        await sleep(throttleMs);
    }
    return mergePositionManagerLists([], all);
}
export async function fetchAaveV4Peripherals(hubSeed = AAVE_V4_HUB_SEED, opts = {}) {
    const graphqlUrl = opts.graphqlUrl ?? process.env.AAVE_GRAPHQL_URL ?? DEFAULT_GRAPHQL_URL;
    const fetchFn = opts.fetchFn ?? fetch;
    const throttleMs = opts.throttleMs ?? 150;
    const chainIdStrs = new Set(Object.keys(hubSeed ?? {}));
    const chainIdsNum = [...chainIdStrs].map((c) => Number(c)).filter((n) => !Number.isNaN(n));
    const result = {};
    for (const cid of chainIdStrs) {
        result[cid] = { perHub: {}, perSpoke: {} };
    }
    if (chainIdsNum.length > 0) {
        try {
            const chainData = await aaveGql(graphqlUrl, CHAINS_QUERY, { chainIds: chainIdsNum }, fetchFn);
            await sleep(throttleMs);
            const byChainId = new Map();
            for (const ch of chainData.chains ?? []) {
                byChainId.set(Number(ch.chainId), {
                    nativeGateway: normAddr(ch.nativeGateway),
                    signatureGateway: normAddr(ch.signatureGateway),
                });
            }
            for (const cid of chainIdStrs) {
                const n = Number(cid);
                const g = byChainId.get(n);
                if (g) {
                    result[cid].nativeGateway = g.nativeGateway;
                    result[cid].signatureGateway = g.signatureGateway;
                }
            }
        }
        catch (e) {
            console.error(`[Aave V4 Peripherals] chains query failed: ${e?.message ?? e}`);
        }
    }
    for (const chainIdStr of Object.keys(hubSeed ?? {})) {
        for (const seed of hubSeed[chainIdStr] ?? []) {
            const hubAddr = seed?.hub;
            if (!hubAddr)
                continue;
            const chainIdNum = Number(chainIdStr);
            if (Number.isNaN(chainIdNum)) {
                console.warn(`[Aave V4 Peripherals] skip invalid chainId: ${chainIdStr}`);
                continue;
            }
            result[chainIdStr] ??= { perHub: {}, perSpoke: {} };
            // Gateways are published per CHAIN by the API; record them against each
            // hub on that chain. A hub the API does not know (a whitelabel instance)
            // gets no entry at all rather than an empty one.
            const hubKey = normAddr(hubAddr);
            const chainGateways = mergeHubGateways(undefined, {
                nativeGateway: result[chainIdStr].nativeGateway,
                signatureGateway: result[chainIdStr].signatureGateway,
            });
            if (Object.keys(chainGateways).length > 0) {
                result[chainIdStr].perHub[hubKey] = chainGateways;
            }
            try {
                const spokeData = await aaveGql(graphqlUrl, SPOKES_QUERY, { hub: hubAddr, chainId: chainIdNum }, fetchFn);
                await sleep(throttleMs);
                const spokes = spokeData.spokes ?? [];
                for (const sp of spokes) {
                    const addrKey = normAddr(sp.address);
                    try {
                        const pms = await fetchAllPositionManagersForSpoke(graphqlUrl, fetchFn, sp.id, throttleMs);
                        result[chainIdStr].perSpoke[addrKey] = {
                            spokeName: String(sp.name ?? ""),
                            spokeId: String(sp.id ?? ""),
                            positionManagers: pms,
                        };
                    }
                    catch (err) {
                        console.error(`[Aave V4 Peripherals] spokePositionManagers failed hub=${hubKey} chain=${chainIdStr} spoke=${addrKey}: ${err?.message ?? err}`);
                        result[chainIdStr].perSpoke[addrKey] = {
                            spokeName: String(sp.name ?? ""),
                            spokeId: String(sp.id ?? ""),
                            positionManagers: [],
                        };
                    }
                    await sleep(throttleMs);
                }
            }
            catch (err) {
                console.error(`[Aave V4 Peripherals] spokes query failed hub=${hubKey} chain=${chainIdStr}: ${err?.message ?? err}`);
            }
        }
    }
    return sortPeripheralsTree(result);
}
