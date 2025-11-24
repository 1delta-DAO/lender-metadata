// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index

import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { multicallRetry, readJsonFile } from "../utils/index.js";

type CTokenMap = { [chainId: string]: { [address: string]: string } };

type CompoundV2ForkMap = { [fork: string]: CTokenMap };

type ReservesMap = { [fork: string]: { [chain: string | number]: string[] } };

// aproach for compound V2
// get cToken list from pool
// fetch underlying per cToken
// store maps
export async function fetchCompoundV2TypeTokenData(): Promise<{
  cTokens: CompoundV2ForkMap;
  reserves: ReservesMap;
  COMPOUND_V2_COMPTROLLERS: any;
}> {
  const COMPOUND_V2_COMPTROLLERS = await readJsonFile(
    "./config/compound-v2-pools.json"
  );
  const forks = Object.keys(COMPOUND_V2_COMPTROLLERS);
  let cTokens: CompoundV2ForkMap = {};
  let reserves: ReservesMap = {};
  for (const fork of forks) {
    // @ts-ignore
    const addressSet = COMPOUND_V2_COMPTROLLERS[fork];
    const chains = Object.keys(addressSet);
    let dataMap: CTokenMap = {};
    reserves[fork] = {};
    for (const chain of chains) {
      const address = addressSet[chain];
      let data: any;
      console.log("fetching for", chain, fork);
      try {
        const [DataMarkets] = (await multicallRetry({
          chainId: chain,
          allowFailure: false,
          contracts: [
            {
              abi: COMPTROLLER_ABIS,
              functionName: CompoundV2FetchFunctions.getAllMarkets,
              address: address as any,
              args: [],
            },
          ],
        }, 5)) as any;
        data = DataMarkets;
      } catch (e: any) {
        throw e;
      }

      const underlyingCalls = data.map((addr: any) => ({
        abi: COMPTROLLER_ABIS,
        functionName: CompoundV2FetchFunctions.underlying,
        address: addr,
        args: [],
      }));

      // set allowFailure to true to prevent the entire call from failing for tokens that do not have an underlying function
      const underlyingResults = (await multicallRetry(
        {
          chainId: chain,
          allowFailure: false,
          contracts: underlyingCalls,
        },
        5
      )) as any[];

      // if the call fails, return address 0 as the underlying
      const Reserves = underlyingResults.map((result: any) => {
        return result;
      });

      // assign reserves
      reserves[fork][chain] = Reserves.map((r: any) => r.toLowerCase());

      const dataOnChain = Object.assign(
        {},
        ...Reserves.map((a: any, i: number) => {
          return {
            [a.toLowerCase()]: data[i].toLowerCase(),
          };
        })
      );
      dataMap[chain] = dataOnChain;
    }
    cTokens[fork] = dataMap;
    dataMap = {};
  }
  return { cTokens, reserves, COMPOUND_V2_COMPTROLLERS };
}
