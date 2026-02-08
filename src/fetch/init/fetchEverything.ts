import { getEvmClient } from "@1delta/providers";
import { INIT_ABIS, InitFetchFunctions } from "./abi.js";
import { readJsonFile } from "../utils/index.js";

// @ts-ignore
BigInt.prototype["toJSON"] = function () {
  return this.toString();
};

type PoolEntry = { pool: string; underlying: string; modes: number[] };

type InitMap = {
  [fork: string]: {
    [chainid: string | number]: PoolEntry[];
  };
};

function uniqueStrings(arr: string[]) {
  return [...new Set(arr)];
}
const defaultModeSearch = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// aproach for init
// get mode configs for defaults
// fetch underlying per pool
// store maps
export async function fetchInitData(): Promise<{
  initDataMap: InitMap;
  INIT_CONFIG_PER_CHAIN_MAP: any;
}> {
  let initDataMap: InitMap = {};
  const INIT_CONFIG_PER_CHAIN_MAP = await readJsonFile(
    "./config/init-pools.json"
  );
  const forks = Object.keys(INIT_CONFIG_PER_CHAIN_MAP);
  for (const fork of forks) {
    initDataMap[fork] = {};
    const chains = Object.keys(INIT_CONFIG_PER_CHAIN_MAP[fork]);
    for (const chain of chains) {
      const initConfig = INIT_CONFIG_PER_CHAIN_MAP[fork][chain];
      const client = getEvmClient(chain);

      const poolsPerMode = (await client.multicall({
        allowFailure: false,
        contracts: defaultModeSearch.map((mode) => ({
          abi: INIT_ABIS,
          functionName: InitFetchFunctions.getModeConfig,
          address: initConfig,
          args: [mode],
        })) as any[],
      })) as any;

      const allPools = uniqueStrings(
        defaultModeSearch.map((_, i) => poolsPerMode[i]?.[0]).flat() as string[]
      );

      const allUnderlyings = (await client.multicall({
        allowFailure: false,
        contracts: allPools.map((pool) => ({
          abi: INIT_ABIS,
          functionName: InitFetchFunctions.underlyingToken,
          address: pool,
          args: [],
        })) as any[],
      })) as any;
      const poolEntryMap: { [pool: string]: PoolEntry } = {};
      for (let i = 0; i < allPools.length; i++) {
        const pool = allPools[i].toLowerCase();
        poolEntryMap[pool] = {
          pool,
          underlying: allUnderlyings[i].toLowerCase(),
          modes: [],
        };
      }
      for (let i = 0; i < defaultModeSearch.length; i++) {
        const mode = defaultModeSearch[i];
        let [collaterals, ,]: [string[], string[], bigint] = poolsPerMode[i];
        collaterals.forEach((c) => {
          poolEntryMap[c.toLowerCase()].modes.push(mode);
        });
      }
      initDataMap[fork][chain] = Object.values(poolEntryMap);
    }
  }

  return { initDataMap, INIT_CONFIG_PER_CHAIN_MAP };
}
