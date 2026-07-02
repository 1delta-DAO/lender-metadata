// ============================================================================
// Mystic Finance API fetcher (Morpho Blue fork on Flare/Plume/Citrea/etc.)
//
// Endpoints:
//   - https://api.mysticfinance.xyz/morphoCache/?chainId=<id>      (full)
//   - https://api.mysticfinance.xyz/morphoCache/lite?chainId=<id>  (lite)
//
// We prefer the "full" endpoint because it carries IRM, token decimals, and
// exact loan/collateral addresses on each market — which the downstream
// Morpho pipeline needs (the lite endpoint only has symbols + LLTV).
//
// Output is reshaped to match the unified item shape consumed by
// MorphoBlueUpdater (same as the Morpho API and the Goldsky subgraph path).
// ============================================================================
const FULL_URL = "https://api.mysticfinance.xyz/morphoCache/";
export const MYSTIC_CHAIN_IDS = new Set([
    "14", // Flare
    "98866", // Plume
    "4114", // Citrea
]);
export function hasMysticApi(chainId) {
    return MYSTIC_CHAIN_IDS.has(chainId);
}
function curatorEntry(name) {
    return { id: name, image: "", verified: false, name };
}
/** Convert Mystic's decimal lltv (e.g. 0.625) into raw 18-decimal string. */
function lltvToWad(lltvDecimal) {
    if (!Number.isFinite(lltvDecimal))
        return "0";
    // Use BigInt arithmetic to preserve full 18-decimal precision.
    const scaled = BigInt(Math.round(lltvDecimal * 1e9));
    return (scaled * 10n ** 9n).toString();
}
function dedupCurators(names) {
    const seen = new Map();
    for (const name of names) {
        if (!name)
            continue;
        if (!seen.has(name))
            seen.set(name, curatorEntry(name));
    }
    return Array.from(seen.values());
}
/**
 * Fetch markets from the Mystic Finance full cache endpoint and reshape them
 * into the format MorphoBlueUpdater consumes (same as the official Morpho
 * API and the Goldsky subgraph path).
 */
export async function fetchMarketsFromMysticApi(chainId) {
    const res = await fetch(`${FULL_URL}?chainId=${chainId}`);
    if (!res.ok) {
        throw new Error(`Mystic API error for chain ${chainId}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json());
    const markets = body.markets ?? [];
    const vaults = body.vaults ?? [];
    // Build a lookup of curators per vault address — vault refs on a market
    // sometimes only carry the address, so we fall back to the vault list.
    const curatorsByVault = new Map();
    for (const v of vaults) {
        const names = [];
        if (v.curatorName)
            names.push(v.curatorName);
        for (const c of v.coCurators ?? [])
            names.push(c);
        if (names.length)
            curatorsByVault.set(v.address.toLowerCase(), names);
    }
    const items = markets.map((m) => {
        const loanAddr = (m.loanToken ?? "").toLowerCase();
        const collateralAddr = (m.collateralToken ?? "").toLowerCase();
        const refCurators = [];
        for (const ref of m.vaults ?? []) {
            if (ref.curator)
                refCurators.push(ref.curator);
            for (const name of ref.curators ?? [])
                refCurators.push(name);
            for (const name of ref.coCurators ?? [])
                refCurators.push(name);
            const addr = (ref.vault ?? ref.address ?? "").toLowerCase();
            if (addr) {
                const fromVault = curatorsByVault.get(addr) ?? [];
                for (const name of fromVault)
                    refCurators.push(name);
            }
        }
        const curators = dedupCurators(refCurators);
        return {
            uniqueKey: m.marketId,
            lltv: lltvToWad(m.lltv),
            oracleAddress: m.oracle,
            irm: m.irm,
            whitelisted: true,
            loanAsset: {
                address: loanAddr,
                symbol: m.asset?.pair,
                decimals: m.asset?.decimals,
            },
            collateralAsset: {
                address: collateralAddr,
                symbol: m.collateral?.pair,
                decimals: m.collateral?.decimals,
            },
            supplyingVaults: curators.length > 0 ? [{ state: { curators } }] : undefined,
        };
    });
    return { markets: { items } };
}
/**
 * Fetch the Mystic market listing for a single chain in a flat shape suited
 * to the dedicated `update-mystic-markets` job (id + symbols + addresses +
 * lltv). Markets without a stable id are skipped.
 */
export async function fetchMysticMarkets(chainId) {
    const res = await fetch(`${FULL_URL}?chainId=${chainId}`);
    if (!res.ok) {
        throw new Error(`Mystic API error for chain ${chainId}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json());
    const out = [];
    const seen = new Set();
    for (const m of body.markets ?? []) {
        if (!m.marketId || seen.has(m.marketId))
            continue;
        seen.add(m.marketId);
        out.push({
            id: m.marketId,
            chainId,
            loanSymbol: m.asset?.pair ?? "",
            collateralSymbol: m.collateral?.pair ?? "",
            loanToken: (m.loanToken ?? "").toLowerCase(),
            collateralToken: (m.collateralToken ?? "").toLowerCase(),
            lltv: m.lltv,
        });
    }
    return out;
}
/** Fetches all Mystic markets across the supported chains. */
export async function fetchAllMysticMarkets() {
    const byChain = {};
    for (const chainId of MYSTIC_CHAIN_IDS) {
        try {
            byChain[chainId] = await fetchMysticMarkets(chainId);
        }
        catch (err) {
            console.warn(`Mystic markets fetch failed for chain ${chainId}:`, err);
            byChain[chainId] = [];
        }
    }
    return byChain;
}
/**
 * Fetch the Mystic vault listing for a single chain. Returns lowercased
 * vault + underlying addresses and the on-chain vault name. Vaults missing
 * an underlying or address are skipped.
 */
export async function fetchMysticVaults(chainId) {
    const res = await fetch(`${FULL_URL}?chainId=${chainId}`);
    if (!res.ok) {
        throw new Error(`Mystic API error for chain ${chainId}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json());
    const out = [];
    const seen = new Set();
    for (const v of body.vaults ?? []) {
        const addr = (v.address ?? "").toLowerCase();
        const underlying = (v.asset ?? "").toLowerCase();
        if (!addr || !underlying || seen.has(addr))
            continue;
        seen.add(addr);
        out.push({
            address: addr,
            underlying,
            name: v.name ?? v.assetSymbol ?? "",
        });
    }
    return out;
}
/** Fetches all Mystic vaults across the supported chains. */
export async function fetchAllMysticVaults() {
    const byChain = {};
    for (const chainId of MYSTIC_CHAIN_IDS) {
        try {
            byChain[chainId] = await fetchMysticVaults(chainId);
        }
        catch (err) {
            console.warn(`Mystic vaults fetch failed for chain ${chainId}:`, err);
            byChain[chainId] = [];
        }
    }
    return byChain;
}
