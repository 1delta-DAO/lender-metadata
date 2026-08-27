// ============================================================================
// Discover Aave V4 spoke names and turn them into lender labels.
//
// WHY THIS EXISTS
// ---------------
// Every Aave V4 spoke is its own lender to the rest of the stack — the lender
// id is `aave-v4-<spoke>`, so the label key is `AAVE_V4_<SPOKE>` (uppercase, no
// `0x`). Until now nothing generated those keys: the ~12 that sit in
// `data/lender-labels.json` were hand-written in one pass (commit `8af7451`),
// so every spoke Aave has listed since then renders as its raw id.
//
// `update:aave-v4-pm-names` does NOT cover this. That pass names POSITION
// MANAGERS inside `config/aave-v4-peripherals.json` (Giver / Taker / Config, by
// bytecode selector) — a different key space entirely. It has no idea what a
// lender label is.
//
// THE NAME SOURCE
// ---------------
// Spoke names are curated by Aave and only published through their GraphQL API
// (`spokes(request: { query: { hub: ... } })` -> `name`). They are NOT readable
// on-chain — the fetcher that discovers spokes from the hubs has no name to
// read, which is why `fetchV4Configs` falls back to the `Spoke 0xabcd..1234`
// placeholder. So the API is the only source, and this module is the only
// consumer of it for labels.
//
// A spoke can hang off more than one hub (Ethena Ecosystem is on both the Core
// and Plus hubs, Bluechip on both Core and Prime) and the API returns the same
// name from each, so discovery flattens to one entry per (chain, spoke) and
// warns if two hubs ever disagree.
//
//   names[AAVE_V4_774B9655413C34809C1F1B16B654465A89EBE989]      = "Aave V4 Maple SyrupUSDG"
//   shortNames[AAVE_V4_774B9655413C34809C1F1B16B654465A89EBE989] = "Aave V4 Maple SyrupUSDG"
//
// Short name == long name, matching the 12 hand-written entries. There is no
// shorter form to derive: the spoke name is already the distinguishing part and
// dropping the "Aave V4 " prefix would collide with Aave V3's "Main"/"Prime".
// ============================================================================
import { sleep } from "../../utils.js";
import { DEFAULT_GRAPHQL_URL, SPOKES_QUERY, aaveGql, fetchAllPositionManagersForSpoke, } from "./fetchV4Peripherals.js";
import { AAVE_V4_HUB_SEED } from "./v4Hubs.js";
/**
 * The synthetic label `fetchV4Configs` writes when a spoke has no curated name
 * (`Spoke 0x774b..e989`). It is a placeholder, not a name — treating it as one
 * would publish "Aave V4 Spoke 0x774b..e989" as a display label, which is worse
 * than no label at all because it looks intentional.
 */
export function isPlaceholderSpokeLabel(label) {
    const trimmed = label?.trim();
    if (!trimmed)
        return true;
    return /^Spoke 0x[0-9a-f]{4}\.\.[0-9a-f]{4}$/i.test(trimmed);
}
/** `0x774b…e989` -> `AAVE_V4_774B…E989`, the key shape used by lender ids. */
export function aaveV4LenderKey(spoke) {
    const addr = spoke.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
        throw new Error(`Not a spoke address: ${spoke}`);
    }
    return `AAVE_V4_${addr.slice(2).toUpperCase()}`;
}
/**
 * Build the label records for a set of named spokes. Entries whose name is
 * empty or still a placeholder are skipped — see `isPlaceholderSpokeLabel`.
 */
export function buildAaveV4Labels(entries) {
    const names = {};
    const shortNames = {};
    for (const e of entries) {
        const name = (e.name ?? "").trim();
        if (!name || isPlaceholderSpokeLabel(name))
            continue;
        const key = aaveV4LenderKey(e.spoke);
        const label = `Aave V4 ${name}`;
        names[key] = label;
        shortNames[key] = label;
    }
    return { names, shortNames };
}
/**
 * Walk every seeded hub and collect the spoke names the API publishes.
 *
 * Failures are per-hub and non-fatal: one unreachable hub must not blank out
 * the labels of the other three. The caller decides what an empty overall
 * result means (`update-aave-v4-labels.ts` refuses to write on it).
 */
export async function discoverAaveV4SpokeNames(opts = {}) {
    const graphqlUrl = opts.graphqlUrl ?? process.env.AAVE_GRAPHQL_URL ?? DEFAULT_GRAPHQL_URL;
    const fetchFn = opts.fetchFn ?? fetch;
    const throttleMs = opts.throttleMs ?? 150;
    const hubSeed = opts.hubSeed ?? AAVE_V4_HUB_SEED;
    // Keyed `chainId:spoke` so the same spoke reached through two hubs collapses
    // to one entry.
    const byKey = new Map();
    for (const chainId of Object.keys(hubSeed)) {
        const chainIdNum = Number(chainId);
        if (Number.isNaN(chainIdNum)) {
            console.warn(`[aave-v4-labels] skip invalid chainId: ${chainId}`);
            continue;
        }
        for (const { hub, attribution } of hubSeed[chainId] ?? []) {
            let spokes;
            try {
                const data = await aaveGql(graphqlUrl, SPOKES_QUERY, { hub, chainId: chainIdNum }, fetchFn);
                spokes = data.spokes ?? [];
            }
            catch (e) {
                console.warn(`[aave-v4-labels] spokes query failed chain=${chainId} hub=${hub} (${attribution}): ${e?.message ?? e}`);
                continue;
            }
            for (const sp of spokes) {
                const addr = String(sp.address ?? "").toLowerCase();
                if (!/^0x[0-9a-f]{40}$/.test(addr))
                    continue;
                const name = String(sp.name ?? "").trim();
                const key = `${chainId}:${addr}`;
                const prev = byKey.get(key);
                if (prev) {
                    if (name && prev.name && prev.name !== name) {
                        console.warn(`[aave-v4-labels] chain ${chainId} spoke ${addr}: name differs by hub ` +
                            `("${prev.name}" via ${prev.hubAttribution}, "${name}" via ${attribution}) — keeping the first`);
                    }
                    continue;
                }
                byKey.set(key, {
                    chainId,
                    spoke: addr,
                    spokeId: String(sp.id ?? ""),
                    name,
                    hubAttribution: attribution,
                });
            }
            await sleep(throttleMs);
        }
    }
    return [...byKey.values()].sort((a, b) => Number(a.chainId) - Number(b.chainId) || a.spoke.localeCompare(b.spoke));
}
/**
 * Position managers for a spoke the peripherals file has never seen. Only
 * called when adding a brand-new spoke entry — an entry with an empty PM list
 * would silently break the composer leverage flow for that spoke, so it is
 * better to pay one extra paginated query than to write a half-filled record.
 *
 * Note the API labels only the gateways; the Giver/Taker/Config PMs come back
 * as "Unknown" and are resolved afterwards by `update:aave-v4-pm-names`.
 */
export async function fetchSpokePositionManagers(spokeId, opts = {}) {
    const graphqlUrl = opts.graphqlUrl ?? process.env.AAVE_GRAPHQL_URL ?? DEFAULT_GRAPHQL_URL;
    const fetchFn = opts.fetchFn ?? fetch;
    const throttleMs = opts.throttleMs ?? 150;
    return fetchAllPositionManagersForSpoke(graphqlUrl, fetchFn, spokeId, throttleMs);
}
