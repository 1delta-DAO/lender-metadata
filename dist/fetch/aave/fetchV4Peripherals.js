/**
 * Aave V4 peripheral addresses from the Aave Kit GraphQL API
 * (same backend as @aave/client / aave-v4-sdk).
 */
import { sleep } from "../../utils.js";
const DEFAULT_GRAPHQL_URL = "https://api.aave.com/graphql";
/** Stable key ordering for JSON diffs */
export function sortPeripheralsTree(data) {
    const out = {};
    const chainKeys = Object.keys(data).sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb)
            return na - nb;
        return a.localeCompare(b);
    });
    for (const chain of chainKeys) {
        const c = data[chain];
        const forks = {};
        for (const fk of Object.keys(c.forks).sort()) {
            const f = c.forks[fk];
            const spokes = {};
            for (const sk of Object.keys(f.spokes).sort()) {
                spokes[sk] = f.spokes[sk];
            }
            forks[fk] = { hub: f.hub, spokes };
        }
        out[chain] = {
            nativeGateway: c.nativeGateway,
            signatureGateway: c.signatureGateway,
            forks,
        };
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
function pickGateway(incoming, existing) {
    if (isValidAddr(incoming))
        return normAddr(incoming);
    if (isValidAddr(existing))
        return normAddr(existing);
    return "";
}
/** Merge PM rows by lowercase address; incoming fields win on conflict. */
export function mergePositionManagerLists(prev, next) {
    const merged = new Map();
    for (const p of prev) {
        const k = normAddr(p.address);
        merged.set(k, { ...p, address: k });
    }
    for (const n of next) {
        const k = normAddr(n.address);
        const existing = merged.get(k);
        merged.set(k, existing ? { ...existing, ...n, address: k } : { ...n, address: k });
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
function mergeForkEntry(prev, next) {
    if (!prev)
        return next;
    const spokes = { ...prev.spokes };
    for (const [addr, spoke] of Object.entries(next.spokes)) {
        spokes[addr] = mergeSpokeEntry(spokes[addr], spoke);
    }
    return {
        hub: isValidAddr(next.hub) ? normAddr(next.hub) : prev.hub,
        spokes,
    };
}
/**
 * Deep merge for persisted peripherals: preserves prior gateways/spokes when a fetch is partial.
 */
export function mergeAaveV4PeripheralsData(oldData, newData) {
    const chains = new Set([...Object.keys(oldData ?? {}), ...Object.keys(newData ?? {})]);
    const result = {};
    for (const chain of chains) {
        const o = oldData?.[chain];
        const n = newData?.[chain];
        if (!n && o) {
            result[chain] = o;
            continue;
        }
        if (!o && n) {
            result[chain] = n;
            continue;
        }
        if (!n && !o)
            continue;
        const forks = new Set([...Object.keys(o?.forks ?? {}), ...Object.keys(n?.forks ?? {})]);
        const forksOut = {};
        for (const fork of forks) {
            const fo = o?.forks?.[fork];
            const fn = n?.forks?.[fork];
            if (!fn && fo) {
                forksOut[fork] = fo;
                continue;
            }
            if (!fo && fn) {
                forksOut[fork] = fn;
                continue;
            }
            if (!fn && !fo)
                continue;
            forksOut[fork] = mergeForkEntry(fo, fn);
        }
        result[chain] = {
            nativeGateway: pickGateway(n?.nativeGateway, o?.nativeGateway),
            signatureGateway: pickGateway(n?.signatureGateway, o?.signatureGateway),
            forks: forksOut,
        };
    }
    return sortPeripheralsTree(result);
}
async function aaveGql(url, query, variables, fetchFn) {
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
const SPOKES_QUERY = `
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
async function fetchAllPositionManagersForSpoke(graphqlUrl, fetchFn, spokeId, throttleMs) {
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
export async function fetchAaveV4Peripherals(hubSeed, opts = {}) {
    const graphqlUrl = opts.graphqlUrl ?? process.env.AAVE_GRAPHQL_URL ?? DEFAULT_GRAPHQL_URL;
    const fetchFn = opts.fetchFn ?? fetch;
    const throttleMs = opts.throttleMs ?? 150;
    const chainIdStrs = new Set();
    for (const fork of Object.keys(hubSeed)) {
        for (const c of Object.keys(hubSeed[fork] ?? {})) {
            chainIdStrs.add(c);
        }
    }
    const chainIdsNum = [...chainIdStrs].map((c) => Number(c)).filter((n) => !Number.isNaN(n));
    const result = {};
    for (const cid of chainIdStrs) {
        result[cid] = {
            nativeGateway: "",
            signatureGateway: "",
            forks: {},
        };
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
    for (const fork of Object.keys(hubSeed)) {
        const byChain = hubSeed[fork] ?? {};
        for (const chainIdStr of Object.keys(byChain)) {
            const hubAddr = byChain[chainIdStr]?.hub;
            if (!hubAddr)
                continue;
            const chainIdNum = Number(chainIdStr);
            if (Number.isNaN(chainIdNum)) {
                console.warn(`[Aave V4 Peripherals] skip invalid chainId: ${chainIdStr}`);
                continue;
            }
            if (!result[chainIdStr]) {
                result[chainIdStr] = {
                    nativeGateway: "",
                    signatureGateway: "",
                    forks: {},
                };
            }
            result[chainIdStr].forks[fork] = {
                hub: normAddr(hubAddr),
                spokes: {},
            };
            try {
                const spokeData = await aaveGql(graphqlUrl, SPOKES_QUERY, { hub: hubAddr, chainId: chainIdNum }, fetchFn);
                await sleep(throttleMs);
                const spokes = spokeData.spokes ?? [];
                for (const sp of spokes) {
                    const addrKey = normAddr(sp.address);
                    try {
                        const pms = await fetchAllPositionManagersForSpoke(graphqlUrl, fetchFn, sp.id, throttleMs);
                        result[chainIdStr].forks[fork].spokes[addrKey] = {
                            spokeName: String(sp.name ?? ""),
                            spokeId: String(sp.id ?? ""),
                            positionManagers: pms,
                        };
                    }
                    catch (err) {
                        console.error(`[Aave V4 Peripherals] spokePositionManagers failed fork=${fork} chain=${chainIdStr} spoke=${addrKey}: ${err?.message ?? err}`);
                        result[chainIdStr].forks[fork].spokes[addrKey] = {
                            spokeName: String(sp.name ?? ""),
                            spokeId: String(sp.id ?? ""),
                            positionManagers: [],
                        };
                    }
                    await sleep(throttleMs);
                }
            }
            catch (err) {
                console.error(`[Aave V4 Peripherals] spokes query failed fork=${fork} chain=${chainIdStr}: ${err?.message ?? err}`);
            }
        }
    }
    return sortPeripheralsTree(result);
}
