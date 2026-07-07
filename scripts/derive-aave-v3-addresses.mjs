// ============================================================================
// Derive the config/aave-pools.json entry for an Aave V2/V3-type market from a
// single known address (an aToken, or the Pool itself).
//
// Why: adding an Aave-fork market to config/aave-pools.json needs its `pool` and
// `protocolDataProvider`. Both are reachable on-chain from any one of the
// market's aTokens:
//
//     aToken --POOL()--> Pool --ADDRESSES_PROVIDER()--> PoolAddressesProvider
//     PoolAddressesProvider --getPoolDataProvider()--> ProtocolDataProvider
//
// (aTokens expose POOL(); the Pool exposes ADDRESSES_PROVIDER(); the addresses
// provider exposes getPoolDataProvider()/getPriceOracle().) This script walks
// that chain and prints a ready-to-paste `{ pool, protocolDataProvider }` block,
// and reports whether the market is Aave V2 or V3 so you pick the right fork.
//
// V2 vs V3: the V3 PoolAddressesProvider exposes getPool()/getPoolDataProvider();
// the V2 LendingPoolAddressesProvider exposes getLendingPool() and has no
// getPoolDataProvider(). We probe both and classify accordingly.
//
// Usage:
//   node scripts/derive-aave-v3-addresses.mjs <chainId> <aTokenOrPool>
//
// Example (Avalon on Pharos, from one of its aTokens):
//   node scripts/derive-aave-v3-addresses.mjs 1672 0x97cf68b9F081B568C240e13807B8f7D9f7292a0d
//   -> Pharos Avalon Market (AAVE V3)
//      "1672": { "pool": "0xD9B9E4F8…", "protocolDataProvider": "0x361D7867…" }
//
// The RPC is resolved from @1delta/providers, so any chain the registry knows
// works without hardcoding an endpoint.
// ============================================================================

import { getEvmClientUniversal } from "@1delta/providers";
import { parseAbi } from "viem";

const [chainId, input] = process.argv.slice(2);
if (!chainId || !input) {
  console.error(
    "usage: node scripts/derive-aave-v3-addresses.mjs <chainId> <aTokenOrPool>",
  );
  process.exit(1);
}

const client = getEvmClientUniversal({ chain: chainId, rpcId: 0 });

async function read(address, sig, fn, args = []) {
  try {
    return await client.readContract({
      address,
      abi: parseAbi([sig]),
      functionName: fn,
      args,
    });
  } catch {
    return null;
  }
}

async function main() {
  // Treat the input as an aToken first (aTokens expose POOL()); fall back to
  // treating it as the Pool itself.
  let pool = await read(input, "function POOL() view returns (address)", "POOL");
  if (!pool) pool = input;

  const provider = await read(
    pool,
    "function ADDRESSES_PROVIDER() view returns (address)",
    "ADDRESSES_PROVIDER",
  );
  if (!provider) {
    console.error(
      `Could not resolve ADDRESSES_PROVIDER() from ${pool} — is this an Aave-type aToken/pool on chain ${chainId}?`,
    );
    process.exit(1);
  }

  const [dataProvider, oracle, marketId, lendingPool] = await Promise.all([
    read(provider, "function getPoolDataProvider() view returns (address)", "getPoolDataProvider"),
    read(provider, "function getPriceOracle() view returns (address)", "getPriceOracle"),
    read(provider, "function getMarketId() view returns (string)", "getMarketId"),
    read(provider, "function getLendingPool() view returns (address)", "getLendingPool"),
  ]);

  // V3 exposes getPoolDataProvider(); V2 exposes getLendingPool() and does not.
  const version = dataProvider ? "V3" : lendingPool ? "V2" : "UNKNOWN";
  const protocolDataProvider =
    dataProvider ??
    // V2 keeps the data provider elsewhere; fall back to id 0x01 on the provider.
    (await read(
      provider,
      "function getAddress(bytes32) view returns (address)",
      "getAddress",
      ["0x0100000000000000000000000000000000000000000000000000000000000000"],
    ));

  console.log(`${marketId ?? "(no market id)"} — AAVE ${version}`);
  console.log(`  pool:                 ${pool}`);
  console.log(`  poolAddressesProvider:${provider}`);
  console.log(`  protocolDataProvider: ${protocolDataProvider}`);
  console.log(`  priceOracle:          ${oracle}`);
  console.log("\nconfig/aave-pools.json entry:");
  console.log(
    JSON.stringify(
      { [chainId]: { pool, protocolDataProvider } },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
