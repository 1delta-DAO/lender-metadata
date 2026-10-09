/**
 * "Unlisted but vault-funded" Morpho Blue markets — the metadata-side
 * counterpart of margin-fetcher's `lending/public-data/morpho/vaultFunded.ts`.
 *
 * SAME RULE, SAME TWO CONSTANTS, IN BOTH REPOS. margin-fetcher decides which of
 * these markets are SERVED and PRICED; this file decides which get a NAME, a
 * curator list and an oracle row. Nothing can check parity across repos, so the
 * reason is stated at both ends (as for `SERVES_UNLISTED_CHAINS` /
 * `MORPHO_UNLISTED_CHAINS`): a market served without a roster row has no label
 * and no oracle classification; a roster row nobody serves is dead weight.
 *
 * The rule: on a chain that applies Morpho's `listed` curation, an unlisted
 * market is served iff MetaMorpho (v1) vaults — `state.allocation[].
 * supplyAssetsUsd` — plus Vault V2 vaults — `caps[type=MarketV1].allocation`
 * priced at the vault asset's USD price — together supply at least
 * {@link MORPHO_VAULT_FUNDED_MIN_USD}. Only vaults holding at least
 * {@link MORPHO_VAULT_FUNDED_MIN_VAULT_USD} in total are read. Idle markets (no
 * collateral / no oracle) never qualify.
 *
 * Why: listed-only hid real exposure. 2026-10-03: Arbitrum xUSD/USDC
 * (0x9e90…7709) — $141M supplied, 100 % utilised, $7.55M from "Vaultik USDC"
 * and "Not Gauntlet" — and Ethereum deUSD/USDC (0xbd1a…1f) were both unlisted,
 * both funded by vaults, both against a drained collateral, and both invisible.
 * Why not unmute those chains: they carry spam unlisted markets (PAXG/USDC
 * "$12.5B", K/USDC "$12.8B", 26 HERMES/USDC on Base). A vault allocation costs
 * real money; a market listing costs nothing.
 */
export const MORPHO_VAULT_FUNDED_MIN_USD = 10_000;
/** Vaults below this total are not read at all (dust / test vaults). */
export const MORPHO_VAULT_FUNDED_MIN_VAULT_USD = 1_000;
const BASE_URL = "https://blue-api.morpho.org/graphql";
const V1_PAGE = 100;
const V2_PAGE = 50;
const MAX_PAGES = 20;
const ZERO = "0x0000000000000000000000000000000000000000";
const v1Query = (first, skip, chainId) => `{
  vaults(first: ${first}, skip: ${skip}, where: { chainId_in: [${chainId}], totalAssetsUsd_gte: ${MORPHO_VAULT_FUNDED_MIN_VAULT_USD} }) {
    items { state { allocation { supplyAssetsUsd market { marketId listed collateralAsset { address } } } } }
  }
}`;
const v2Query = (first, skip, chainId) => `{
  vaultV2s(first: ${first}, skip: ${skip}, where: { chainId_in: [${chainId}], totalAssetsUsd_gte: ${MORPHO_VAULT_FUNDED_MIN_VAULT_USD} }) {
    items {
      totalAssets
      totalAssetsUsd
      asset { decimals price { usd } }
      caps { items { type allocation data { __typename ... on MarketV1CapData { market { marketId listed collateralAsset { address } } } } } }
    }
  }
}`;
const isUnlistedLendable = (m) => {
    if (m?.listed !== false)
        return false;
    const coll = String(m?.collateralAsset?.address ?? "").toLowerCase();
    return !!coll && coll !== ZERO;
};
/** Pure: per-market vault USD for unlisted, non-idle markets, at or above `minUsd`. */
export function sumVaultFundedUnlisted(v1Vaults, v2Vaults, minUsd = MORPHO_VAULT_FUNDED_MIN_USD) {
    const byMarket = new Map();
    const add = (marketId, usd) => {
        if (typeof marketId !== "string" || usd == null || !Number.isFinite(usd) || usd <= 0)
            return;
        const k = marketId.toLowerCase();
        byMarket.set(k, (byMarket.get(k) ?? 0) + usd);
    };
    for (const v of v1Vaults) {
        for (const a of v?.state?.allocation ?? []) {
            if (!isUnlistedLendable(a?.market))
                continue;
            add(a.market.marketId, typeof a.supplyAssetsUsd === "number" ? a.supplyAssetsUsd : null);
        }
    }
    for (const v of v2Vaults) {
        const decimals = typeof v?.asset?.decimals === "number" ? v.asset.decimals : null;
        let price = typeof v?.asset?.price?.usd === "number" ? v.asset.price.usd : null;
        const total = Number(v?.totalAssets ?? 0);
        if (price == null && decimals != null && total > 0 && typeof v?.totalAssetsUsd === "number")
            price = v.totalAssetsUsd / (total / 10 ** decimals);
        for (const c of v?.caps?.items ?? []) {
            if (c?.type !== "MarketV1")
                continue;
            const m = c?.data?.market;
            if (!isUnlistedLendable(m))
                continue;
            const raw = Number(c.allocation ?? 0);
            add(m.marketId, price != null && decimals != null ? (raw / 10 ** decimals) * price : null);
        }
    }
    return [...byMarket]
        .filter(([, usd]) => usd >= minUsd)
        .map(([marketId, vaultUsd]) => ({ marketId, vaultUsd }))
        .sort((a, b) => b.vaultUsd - a.vaultUsd || a.marketId.localeCompare(b.marketId));
}
async function post(query) {
    const res = await fetch(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    if (!res.ok)
        throw new Error(`blue-api HTTP ${res.status}`);
    const json = (await res.json());
    if (json.errors?.length)
        throw new Error(`blue-api: ${json.errors[0].message}`);
    return json.data;
}
async function pageAll(build, field, size) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const items = (await post(build(size, page * size)))?.[field]?.items;
        if (!Array.isArray(items))
            throw new Error(`unexpected ${field} shape`);
        out.push(...items);
        if (items.length < size)
            return out;
    }
    console.warn(`[morpho-vault-funded] ${field}: hit MAX_PAGES, result truncated`);
    return out;
}
const cache = new Map();
/**
 * Vault-funded unlisted markets of a chain (blue-api). Memoised per process so
 * `MorphoBlueUpdater` and `fetchMorphoOracleData` see the same set in one run.
 * THROWS on failure — callers decide; both treat it as "no additions", which
 * is safe because every write they make is additive.
 */
export function fetchVaultFundedUnlistedMarkets(chainId) {
    let p = cache.get(chainId);
    if (!p) {
        p = Promise.all([
            pageAll((f, s) => v1Query(f, s, chainId), "vaults", V1_PAGE),
            pageAll((f, s) => v2Query(f, s, chainId), "vaultV2s", V2_PAGE),
        ]).then(([v1, v2]) => sumVaultFundedUnlisted(v1, v2));
        p.catch(() => cache.delete(chainId));
        cache.set(chainId, p);
    }
    return p;
}
