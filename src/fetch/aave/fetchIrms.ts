import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { multicallRetry } from "../utils/index.js";

type AssetToIrmMap = Record<string, string>;

export type AaveIrmMap = Record<string, Record<string, AssetToIrmMap>>;

const BATCH_SIZE = 100;

export async function fetchAaveTypeIrms(
  AAVE_FORK_POOL_DATA: any,
  reserves: Record<string, Record<string, string[]>>,
): Promise<AaveIrmMap> {
  const forks = Object.keys(AAVE_FORK_POOL_DATA);
  const forkMap: AaveIrmMap = Object.fromEntries(forks.map((f) => [f, {}]));

  const chainToCalls: Record<
    string,
    { fork: string; protocolDataProvider: string; asset: string }[]
  > = {};

  for (const fork of forks) {
    const chains = Object.keys(reserves?.[fork] ?? {});
    for (const chain of chains) {
      const assets = reserves?.[fork]?.[chain];
      const protocolDataProvider =
        AAVE_FORK_POOL_DATA?.[fork]?.[chain]?.protocolDataProvider;
      if (!protocolDataProvider || !assets?.length) continue;
      if (!chainToCalls[chain]) chainToCalls[chain] = [];
      chainToCalls[chain].push(
        ...assets.map((asset) => ({
          fork,
          protocolDataProvider,
          asset,
        })),
      );
    }
  }

  for (const chain of Object.keys(chainToCalls)) {
    const calls = chainToCalls[chain];
    for (let i = 0; i < calls.length; i += BATCH_SIZE) {
      const batch = calls.slice(i, i + BATCH_SIZE);
      const contracts = batch.map((c) => ({
        abi: AAVE_ABIS(false),
        functionName: AaveFetchFunctions.getInterestRateStrategyAddress,
        address: c.protocolDataProvider as any,
        args: [c.asset],
      }));

      const results = (await multicallRetry({
        chainId: chain,
        allowFailure: true,
        contracts,
      })) as any[];

      for (let j = 0; j < batch.length; j++) {
        const { fork, asset } = batch[j];
        const item = results[j];
        const value = item?.result ?? item;
        if (typeof value !== "string") continue;
        if (value === zeroAddress) continue;
        const assetLower = asset.toLowerCase();
        const irmLower = value.toLowerCase();
        if (!forkMap[fork][chain]) forkMap[fork][chain] = {};
        forkMap[fork][chain][assetLower] = irmLower;
      }

      await sleep(250);
    }
  }

  return forkMap;
}

