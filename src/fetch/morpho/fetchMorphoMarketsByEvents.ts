// ============================================================================
// Enumerate Morpho Blue markets directly from the core contract's
// `CreateMarket` events. Used for chains that have a Morpho Blue deployment
// but no Morpho-API / Goldsky-subgraph coverage (e.g. Kaia), so the main
// MorphoBlueUpdater can't discover their market ids.
//
// Reads through the shared `scanContractEvents` scanner, which serves the
// events from the chain's explorer index where the node cannot (see
// `explorerLogs.ts`) and otherwise walks the chain itself. Skips the idle /
// zero-token market.
// ============================================================================

import { parseAbiItem, zeroAddress } from "viem";
import { scanContractEvents } from "./eventScan.js";

const CREATE_MARKET = parseAbiItem(
  "event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)",
);

export interface OnChainMorphoMarket {
  id: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: string;
}

/**
 * Return every real Morpho Blue market on `chainId`, read from the core's
 * `CreateMarket` events. The idle market (zero loan/collateral) is dropped.
 *
 * Throws if the chain cannot be enumerated — callers should catch per-chain
 * and continue.
 *
 * A scan that completes having seen ZERO events is treated as a FAILURE, not
 * as an empty book. Every Morpho core emits `CreateMarket` at least once (the
 * idle market is created on day one), so zero events means the source never
 * saw the history rather than that there is none — which is exactly what a
 * pruned node produces: `findDeployBlock` binary-searches `eth_getCode` at
 * historical blocks, converges near head when those are unavailable, and the
 * scan then completes cleanly over a recent empty range. Flare returned 0 that
 * way while the chain carried 13 real markets, and because the caller merges
 * append-only there was no error and no diff to notice. Silence is not absence.
 */
export async function fetchMorphoMarketsByEvents(
  chainId: string,
  core: string,
): Promise<OnChainMorphoMarket[]> {
  const out = new Map<string, OnChainMorphoMarket>();
  let sawAnyEvent = false;

  await scanContractEvents(chainId, core, CREATE_MARKET, (l) => {
    const p = l.args?.marketParams;
    const id = String(l.args?.id ?? "").toLowerCase();
    if (!id || !p) return;
    sawAnyEvent = true;
    // Skip the idle / placeholder market (no real loan or collateral).
    if (
      p.loanToken === zeroAddress ||
      p.collateralToken === zeroAddress ||
      p.oracle === zeroAddress
    )
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

  if (!sawAnyEvent) {
    throw new Error(
      `chain ${chainId}: scan of core ${core} completed with no CreateMarket ` +
        `events — treating as an unreadable history rather than an empty book ` +
        `(a pruned node silently produces this)`,
    );
  }

  return [...out.values()];
}
