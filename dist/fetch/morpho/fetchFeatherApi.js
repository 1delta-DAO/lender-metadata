// ============================================================================
// Feather API fetcher (Morpho Blue deployments on chains the Morpho API does
// not index: Celo / Sei / Lisk / Soneium / TAC / Hemi / Kaia).
//
// Endpoint: https://api.feather.zone/graphql
//
// Feather is a thin registry: its `Vault` type exposes `address`, `name`,
// `supplyAPR`, `curator` and `chain` — but NOT the underlying asset. So we
// use it only to DISCOVER vault addresses, then read `asset()` on-chain to
// complete each `{ vault, underlying, name }` entry. This keeps the dataset a
// pure on-chain artifact (no runtime dependency on a hosted indexer).
//
// Output matches the unified `MorphoTypeVault` shape consumed by the
// update-feather-vaults job (same as the Mystic / Lista vault paths).
// ============================================================================
import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
const FEATHER_URL = "https://api.feather.zone/graphql";
/** Morpho-fork chains Feather indexes that have no Morpho-API / Mystic-API
 *  coverage. Disjoint from MYSTIC_CHAIN_IDS (Flare/Plume/Citrea). */
export const FEATHER_CHAIN_IDS = new Set([
    "42220", // Celo
    "1329", // Sei
    "1135", // Lisk
    "1868", // Soneium
    "239", // TAC
    "43111", // Hemi
    "8217", // Kaia
]);
export function hasFeatherApi(chainId) {
    return FEATHER_CHAIN_IDS.has(chainId);
}
const VAULTS_QUERY = `{ vaults { address name chain { chainId } } }`;
const ERC4626_ASSET_ABI = parseAbi(["function asset() view returns (address)"]);
const isHex40 = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
/** Fetch every Feather vault ref, grouped by chainId (only FEATHER_CHAIN_IDS). */
async function fetchFeatherVaultRefs() {
    const res = await fetch(FEATHER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: VAULTS_QUERY }),
    });
    if (!res.ok) {
        throw new Error(`Feather API error: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    if (json?.errors) {
        throw new Error(`Feather GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
    }
    const vaults = json?.data?.vaults ?? [];
    const byChain = {};
    for (const v of vaults) {
        const cid = String(v?.chain?.chainId ?? "");
        if (!FEATHER_CHAIN_IDS.has(cid) || !v?.address)
            continue;
        (byChain[cid] ??= []).push(v);
    }
    return byChain;
}
/** Read `asset()` for a batch of vaults on one chain (allowFailure). */
async function readUnderlyings(chainId, addresses) {
    const results = await multicallRetryUniversal({
        chain: chainId,
        calls: addresses.map((address) => ({ address, name: "asset", args: [] })),
        abi: ERC4626_ASSET_ABI,
        allowFailure: true,
    });
    return results.map((r) => {
        const v = r && typeof r === "object" && "result" in r
            ? r.result
            : r;
        return isHex40(v) ? v.toLowerCase() : undefined;
    });
}
/** Complete Feather refs for one chain into `{ vault, underlying, name }`. */
export async function fetchFeatherVaults(chainId, refs) {
    if (refs.length === 0)
        return [];
    const addresses = refs.map((r) => r.address.toLowerCase());
    const underlyings = await readUnderlyings(chainId, addresses);
    const out = [];
    for (let i = 0; i < refs.length; i++) {
        const underlying = underlyings[i];
        // Skip vaults whose `asset()` is unreadable (non-4626 / dead / RPC miss).
        if (!underlying)
            continue;
        out.push({
            vault: addresses[i],
            underlying,
            ...(refs[i].name ? { name: refs[i].name } : {}),
        });
    }
    return out;
}
export async function fetchAllFeatherVaults() {
    const refs = await fetchFeatherVaultRefs();
    const byChain = {};
    for (const chainId of FEATHER_CHAIN_IDS) {
        try {
            byChain[chainId] = await fetchFeatherVaults(chainId, refs[chainId] ?? []);
        }
        catch (err) {
            console.warn(`Feather vaults fetch failed for chain ${chainId}:`, err);
            byChain[chainId] = [];
        }
    }
    return byChain;
}
