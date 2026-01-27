// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index

import { multicallRetryUniversal } from "@1delta/providers";
import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { multicallRetry, readJsonFile } from "../utils/index.js";
import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";

type AddressMap = { [fork: string]: string };

type CTokenMap = { [chainId: string]: AddressMap };

type CompoundV2ForkMap = { [fork: string]: CTokenMap };

type CTokenArray = {
  [chainId: string]: { cToken: string; underlying: string }[];
};

type CompoundV2ForkArray = { [fork: string]: CTokenArray };

type OracleMap = { [chainId: string]: AddressMap };
type ReservesMap = { [fork: string]: { [chain: string]: string[] } };

// aproach for compound V2
// get cToken list from pool
// fetch underlying per cToken
// store maps
export async function fetchCompoundV2TypeTokenData(): Promise<{
  cTokens: CompoundV2ForkMap;
  cTokenArray: CompoundV2ForkArray;
  reserves: ReservesMap;
  oracles: OracleMap;
  COMPOUND_V2_COMPTROLLERS: any;
}> {
  const COMPOUND_V2_COMPTROLLERS = await readJsonFile(
    "./config/compound-v2-pools.json",
  );

  const forks = Object.keys(COMPOUND_V2_COMPTROLLERS);

  let cTokens: CompoundV2ForkMap = {};

  let oracles: OracleMap = {};

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
      let oracle: string;

      console.log("fetching for", chain, fork);

      try {
        const [marketsData, oracleData] = (await multicallRetry(
          {
            chainId: chain,
            allowFailure: true,
            contracts: [
              {
                abi: COMPTROLLER_ABIS,
                functionName: CompoundV2FetchFunctions.getAllMarkets,
                address: address as any,
                args: [],
              },
              {
                abi: COMPTROLLER_ABIS,
                functionName: CompoundV2FetchFunctions.oracle,
                address: address as any,
                args: [],
              },
            ],
          },
          6,
        )) as any;
        data = marketsData.result;
        oracle = oracleData.result;
      } catch (e: any) {
        console.log(e);
        throw e;
      }

      if (!data) continue;

      const underlyingCalls = data.map((addr: any) => ({
        name: CompoundV2FetchFunctions.underlying,
        address: addr,
        args: [],
      }));

      // set allowFailure to true to prevent the entire call from failing for tokens that do not have an underlying function
      let underlyingResults: any;
      try {
        underlyingResults = (await multicallRetryUniversal({
          abi: COMPTROLLER_ABIS,
          chain,
          allowFailure: true,
          calls: underlyingCalls,
          maxRetries: 10,
        })) as any[];
      } catch (e) {
        throw e;
      }

      await sleep(250);

      // if the call fails, return address 0 as the underlying
      const currReserves = underlyingResults.map((result: any) => {
        return !result || result === "0x" ? zeroAddress : result;
      });

      // assign reserves
      reserves[fork][chain] = currReserves.map((r: any) => r.toLowerCase());
      if (!oracles[fork]) oracles[fork] = {};
      oracles[fork][chain] = oracle;

      const dataOnChain = Object.assign(
        {},
        ...currReserves.map((a: any, i: number) => {
          return {
            [a.toLowerCase()]: data[i].toLowerCase(),
          };
        }),
      );

      const dataArrayOnChain = currReserves.map(
        (underlying: any, i: number) => ({
          cToken: data[i].toLowerCase(),
          underlying: underlying.toLowerCase(),
        }),
      );

      dataMap[chain] = dataOnChain;
      dataArray[chain] = dataArrayOnChain;
    }
    cTokens[fork] = dataMap;
    cTokenArray[fork] = dataArray;
    dataMap = {};
  }
  return { cTokens, cTokenArray, reserves, COMPOUND_V2_COMPTROLLERS, oracles };
}
