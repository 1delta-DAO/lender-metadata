// ============================================================================
// Enumerate Morpho Blue markets directly from the core contract's
// `CreateMarket` events. Used for chains that have a Morpho Blue deployment
// but no Morpho-API / Goldsky-subgraph / Mystic coverage (e.g. Kaia), so the
// main MorphoBlueUpdater can't discover their market ids.
//
// Pure on-chain: binary-searches the core's deploy block, then scans
// `CreateMarket` logs in bounded chunks. Skips the idle / zero-token market.
// ============================================================================

import { parseAbiItem, zeroAddress, type Address } from "viem";
import { getEvmClientUniversal } from "@1delta/providers";

const CREATE_MARKET = parseAbiItem(
  "event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)",
);

const LOG_CHUNK = 90_000n;

export interface OnChainMorphoMarket {
  id: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: string;
}

/** Lowest block at which `address` has bytecode (its deployment block). */
async function findDeployBlock(client: any, address: Address): Promise<bigint> {
  let lo = 0n;
  let hi = await client.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await client
      .getBytecode({ address, blockNumber: mid })
      .catch(() => "0x");
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Return every real Morpho Blue market on `chainId`, read from the core's
 * `CreateMarket` events. The idle market (zero loan/collateral) is dropped.
 */
export async function fetchMorphoMarketsByEvents(
  chainId: string,
  core: string,
): Promise<OnChainMorphoMarket[]> {
  const client = getEvmClientUniversal({ chain: chainId, rpcId: 0 });
  const address = core as Address;
  const latest = await client.getBlockNumber();
  const deploy = await findDeployBlock(client, address);

  const out = new Map<string, OnChainMorphoMarket>();
  for (let from = deploy; from <= latest; from += LOG_CHUNK + 1n) {
    const to = from + LOG_CHUNK > latest ? latest : from + LOG_CHUNK;
    const logs = await client.getLogs({
      address,
      event: CREATE_MARKET,
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs as any[]) {
      const p = l.args?.marketParams;
      const id = String(l.args?.id ?? "").toLowerCase();
      if (!id || !p) continue;
      // Skip the idle / placeholder market (no real loan or collateral).
      if (
        p.loanToken === zeroAddress ||
        p.collateralToken === zeroAddress ||
        p.oracle === zeroAddress
      )
        continue;
      out.set(id, {
        id,
        loanToken: p.loanToken.toLowerCase(),
        collateralToken: p.collateralToken.toLowerCase(),
        oracle: p.oracle.toLowerCase(),
        irm: p.irm.toLowerCase(),
        lltv: p.lltv.toString(),
      });
    }
  }
  return [...out.values()];
}
