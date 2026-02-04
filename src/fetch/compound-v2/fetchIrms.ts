import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { multicallRetry } from "../utils/index.js";

type AssetToIrmMap = Record<string, string>;

export type CompoundV2IrmMap = Record<string, Record<string, AssetToIrmMap>>;

type CTokenArray = Record<
  string,
  Record<string, { cToken: string; underlying: string }[]>
>;

const BATCH_SIZE = 100;

export async function fetchCompoundV2Irms(
  COMPOUND_V2_COMPTROLLERS: any,
  cTokenArray: CTokenArray,
): Promise<CompoundV2IrmMap> {
  const forks = Object.keys(COMPOUND_V2_COMPTROLLERS);
  const forkMap: CompoundV2IrmMap = Object.fromEntries(forks.map((f) => [f, {}]));

  const chainToCalls: Record<
    string,
    { fork: string; cToken: string; underlying: string }[]
  > = {};

  for (const fork of forks) {
    const chains = Object.keys(cTokenArray?.[fork] ?? {});
    for (const chain of chains) {
      const entries = cTokenArray?.[fork]?.[chain];
      if (!entries?.length) continue;
      if (!chainToCalls[chain]) chainToCalls[chain] = [];
      chainToCalls[chain].push(
        ...entries.map((e) => ({
          fork,
          cToken: e.cToken,
          underlying: e.underlying,
        })),
      );
    }
  }

  for (const chain of Object.keys(chainToCalls)) {
    const calls = chainToCalls[chain];
    for (let i = 0; i < calls.length; i += BATCH_SIZE) {
      const batch = calls.slice(i, i + BATCH_SIZE);
      const contracts = batch.map((c) => ({
        abi: COMPTROLLER_ABIS,
        functionName: CompoundV2FetchFunctions.interestRateModel,
        address: c.cToken as any,
        args: [],
      }));

      const results = (await multicallRetry({
        chainId: chain,
        allowFailure: true,
        contracts,
      })) as any[];

      for (let j = 0; j < batch.length; j++) {
        const { fork, underlying } = batch[j];
        const item = results[j];
        const value = item?.result ?? item;
        if (typeof value !== "string") continue;
        if (value === zeroAddress) continue;
        const underlyingLower = underlying.toLowerCase();
        const irmLower = value.toLowerCase();
        if (!forkMap[fork][chain]) forkMap[fork][chain] = {};
        forkMap[fork][chain][underlyingLower] = irmLower;
      }

      await sleep(250);
    }
  }

  return forkMap;
}

