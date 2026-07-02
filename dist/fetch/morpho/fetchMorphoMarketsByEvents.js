// ============================================================================
// Enumerate Morpho Blue markets directly from the core contract's
// `CreateMarket` events. Used for chains that have a Morpho Blue deployment
// but no Morpho-API / Goldsky-subgraph / Mystic coverage (e.g. Kaia), so the
// main MorphoBlueUpdater can't discover their market ids.
//
// Pure on-chain: uses the shared `scanContractEvents` scanner (deploy-block
// search + budgeted, retrying, bisecting log scan). Skips the idle / zero-token
// market.
// ============================================================================
import { parseAbiItem, zeroAddress } from "viem";
import { scanContractEvents } from "./eventScan.js";
const CREATE_MARKET = parseAbiItem("event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)");
/**
 * Return every real Morpho Blue market on `chainId`, read from the core's
 * `CreateMarket` events. The idle market (zero loan/collateral) is dropped.
 *
 * Throws if the chain's RPC is too restrictive to scan within the call budget,
 * or unreachable — callers should catch per-chain and continue.
 */
export async function fetchMorphoMarketsByEvents(chainId, core) {
    const out = new Map();
    await scanContractEvents(chainId, core, CREATE_MARKET, (l) => {
        const p = l.args?.marketParams;
        const id = String(l.args?.id ?? "").toLowerCase();
        if (!id || !p)
            return;
        // Skip the idle / placeholder market (no real loan or collateral).
        if (p.loanToken === zeroAddress ||
            p.collateralToken === zeroAddress ||
            p.oracle === zeroAddress)
            return;
        out.set(id, {
            id,
            loanToken: p.loanToken.toLowerCase(),
            collateralToken: p.collateralToken.toLowerCase(),
            oracle: p.oracle.toLowerCase(),
            irm: p.irm.toLowerCase(),
            lltv: p.lltv.toString(),
        });
    });
    return [...out.values()];
}
