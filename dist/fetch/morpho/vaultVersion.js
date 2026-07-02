// ============================================================================
// On-chain vault-version detection shared by the Morpho-type vault jobs.
//
// Classifies each vault as:
//   - `v2` — Vaults V2 (adapter-based; exposes `adaptersLength()`)
//   - `v1` — MetaMorpho (withdraw-queue; `adaptersLength()` reverts)
//
// Best-effort and batched: one `allowFailure` multicall of `adaptersLength()`.
// A vault that returns a uint is V2; a revert / unreadable result is treated as
// V1 (the overwhelmingly common case).
// ============================================================================
import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
const V2_PROBE_ABI = parseAbi([
    "function adaptersLength() view returns (uint256)",
]);
const unwrap = (r) => r && typeof r === "object" && "result" in r ? r.result : r;
/**
 * Detect the interface version of each vault on `chainId`, index-aligned with
 * `addresses`. A vault whose `adaptersLength()` resolves to a uint is `v2`; a
 * revert (within a successful multicall) is `v1`. If the probe call itself
 * fails (chain unreachable / RPC down) every entry is `null` — undetermined —
 * so callers can leave `version` unset rather than guess. Callers that treat a
 * falsy result as "skip" therefore handle both `null` entries correctly.
 */
export async function detectVaultVersions(chainId, addresses) {
    if (addresses.length === 0)
        return [];
    let probe;
    try {
        probe = (await multicallRetryUniversal({
            chain: chainId,
            calls: addresses.map((address) => ({
                address,
                name: "adaptersLength",
                args: [],
            })),
            abi: V2_PROBE_ABI,
            allowFailure: true,
        }));
    }
    catch {
        return addresses.map(() => null);
    }
    return addresses.map((_, i) => {
        const len = unwrap(probe[i]);
        return typeof len === "bigint" || typeof len === "number" ? "v2" : "v1";
    });
}
