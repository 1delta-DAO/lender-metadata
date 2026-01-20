// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index

import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { multicallRetry, readJsonFile } from "../utils/index.js";
import { zeroAddress } from "viem";

type CTokenMap = { [chainId: string]: { [address: string]: string } };

type CompoundV2ForkMap = { [fork: string]: CTokenMap };

type CTokenArray = { [chainId: string]: { cToken: string, underlying: string }[] };

type CompoundV2ForkArray = { [fork: string]: CTokenArray };

type ReservesMap = { [fork: string]: { [chain: string | number]: string[] } };

// aproach for compound V2
// get cToken list from pool
// fetch underlying per cToken
// store maps
export async function fetchCompoundV2TypeTokenData(): Promise<{
  cTokens: CompoundV2ForkMap;
  cTokenArray: CompoundV2ForkArray;
  reserves: ReservesMap;
  COMPOUND_V2_COMPTROLLERS: any;
}> {
  const COMPOUND_V2_COMPTROLLERS = await readJsonFile(
    "./config/compound-v2-pools.json"
  );

  const forks = Object.keys(COMPOUND_V2_COMPTROLLERS);

  let cTokens: CompoundV2ForkMap = {};

  let cTokenArray: CompoundV2ForkArray = {};

  let reserves: ReservesMap = {};

  for (const fork of forks) {
    // @ts-ignore
    const addressSet = COMPOUND_V2_COMPTROLLERS[fork];
    const chains = Object.keys(addressSet);
    let dataMap: CTokenMap = {};
    let dataArray: CTokenArray = {};
    reserves[fork] = {};
    for (const chain of chains) {

      const address = addressSet[chain];

      let data: any;

      console.log("fetching for", chain, fork);

      try {
        const [marketsData] = (await multicallRetry({
          chainId: chain,
          allowFailure: true,
          contracts: [
            {
              abi: COMPTROLLER_ABIS,
              functionName: CompoundV2FetchFunctions.getAllMarkets,
              address: address as any,
              args: [],
            },
          ],
        }, 5)) as any;
        data = marketsData.result;
      } catch (e: any) {
        throw e;
      }

      if (!data) continue

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
          allowFailure: true,
          contracts: underlyingCalls,
        },
        5
      )) as any[];

      // if the call fails, return address 0 as the underlying
      const currReserves = underlyingResults.map((result: any) => {
        return result?.result ?? zeroAddress;
      });

      // assign reserves
      reserves[fork][chain] = currReserves.map((r: any) => r.toLowerCase());

      const dataOnChain = Object.assign(
        {},
        ...currReserves.map((a: any, i: number) => {
          return {
            [a.toLowerCase()]: data[i].toLowerCase(),
          };
        })
      );

      const dataArrayOnChain = currReserves.map((underlying: any, i: number) => ({
        cToken: data[i].toLowerCase(),
        underlying: underlying.toLowerCase(),
      }));

      dataMap[chain] = dataOnChain;
      dataArray[chain] = dataArrayOnChain;
    }
    cTokens[fork] = dataMap;
    cTokenArray[fork] = dataArray;
    dataMap = {};
  }
  return { cTokens, cTokenArray, reserves, COMPOUND_V2_COMPTROLLERS };
}
