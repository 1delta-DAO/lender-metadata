import { INIT_CONFIG_PER_CHAIN_MAP } from "@1delta/asset-registry";
import { getEvmClient } from "@1delta/providers";
import { INIT_ABIS, InitFetchFunctions } from "./abi.js";

// @ts-ignore
BigInt.prototype["toJSON"] = function () {
  return this.toString();
};

// pool-underlying per mode
type ModeEntry = { pool: string; underlying: string };
type PoolDatas = { [pool: string]: { underlying: string; modes: number[] } };
type ModeData = { [mode: number]: ModeEntry[] };

type InitMap = {
  [fork: string]: {
    [chainid: string | number]: {
      poolsToUnderlying: string;
      modeData: ModeData;
      poolData: PoolDatas;
      reserves: string[];
    };
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
export async function fetchInitData(): Promise<{ initDataMap: InitMap }> {
  let initDataMap: InitMap = {};
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
      const poolsToUnderlying = Object.assign(
        {},
        ...allPools.map((p, i) => {
          return { [p.toLowerCase()]: allUnderlyings[i].toLowerCase() };
        })
      );
      let modeData: ModeData = {};
      let poolData: PoolDatas = {};
      let pools: string[] = Object.keys(poolsToUnderlying);
      let reserves: string[] = Object.values(poolsToUnderlying);
      poolData = Object.assign(
        {},
        ...pools.map((p, i) => {
          return {
            [p.toLowerCase()]: {
              underlying: allUnderlyings[i].toLowerCase(),
              modes: [],
            },
          };
        })
      );
      for (let i = 0; i < defaultModeSearch.length; i++) {
        const mode = defaultModeSearch[i];
        let [collaterals, ,]: [string[], string[], bigint] = poolsPerMode[i];
        modeData[mode] = collaterals.map((c) => ({
          pool: c,
          underlying: poolsToUnderlying[c.toLowerCase()],
        }));
        collaterals.map((c) => {
          poolData[c.toLowerCase()].modes.push(mode);
        });
      }
      initDataMap[fork][chain] = {
        poolData,
        poolsToUnderlying,
        reserves,
        modeData,
      };
    }
  }

  return { initDataMap };
}
