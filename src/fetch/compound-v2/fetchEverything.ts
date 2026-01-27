// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index

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

  const cTokens: CompoundV2ForkMap = {};
  const oracles: OracleMap = {};
  const cTokenArray: CompoundV2ForkArray = {};
  const reserves: ReservesMap = {};

  // Initialize empty structures for all forks
  for (const fork of forks) {
    cTokens[fork] = {};
    cTokenArray[fork] = {};
    reserves[fork] = {};
    oracles[fork] = {};
  }

  // Group all (fork, chain, address) tuples by chain
  const chainToForks: {
    [chain: string]: { fork: string; address: string }[];
  } = {};

  for (const fork of forks) {
    const addressSet = COMPOUND_V2_COMPTROLLERS[fork];
    const chains = Object.keys(addressSet);
    for (const chain of chains) {
      if (!chainToForks[chain]) chainToForks[chain] = [];
      chainToForks[chain].push({ fork, address: addressSet[chain] });
    }
  }

  // Process each chain with batched multicalls
  for (const chain of Object.keys(chainToForks)) {
    const forksOnChain = chainToForks[chain];
    console.log(
      `fetching for chain ${chain}, forks: ${forksOnChain.map((f) => f.fork).join(", ")}`,
    );

    // BATCH CALL 1: Get all markets and oracles for all forks on this chain
    const firstBatchContracts = forksOnChain.flatMap(({ address }) => [
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
    ]);

    let firstBatchResults: any[];
    try {
      firstBatchResults = (await multicallRetry(
        {
          chainId: chain,
          allowFailure: true,
          contracts: firstBatchContracts,
        },
        6,
      )) as any[];
    } catch (e: any) {
      console.log(`Error fetching markets for chain ${chain}:`, e);
      throw e;
    }

    // Parse first batch results and prepare second batch
    const forkMarketData: {
      fork: string;
      markets: string[];
      oracle: string;
    }[] = [];

    for (let i = 0; i < forksOnChain.length; i++) {
      const { fork } = forksOnChain[i];
      const marketsResult = firstBatchResults[i * 2]?.result;
      const oracleResult = firstBatchResults[i * 2 + 1]?.result;

      if (!marketsResult) {
        console.log(`No markets found for ${fork} on chain ${chain}`);
        continue;
      }

      forkMarketData.push({
        fork,
        markets: marketsResult,
        oracle: oracleResult,
      });
    }

    if (forkMarketData.length === 0) continue;

    // BATCH CALL 2: Get all underlyings for all cTokens across all forks on this chain
    const secondBatchContracts = forkMarketData.flatMap(({ markets }) =>
      markets.map((addr: string) => ({
        abi: COMPTROLLER_ABIS,
        functionName: CompoundV2FetchFunctions.underlying,
        address: addr as any,
        args: [],
      })),
    );

    let secondBatchResults: any[];
    try {
      secondBatchResults = (await multicallRetry(
        {
          chainId: chain,
          allowFailure: true,
          contracts: secondBatchContracts,
        },
        6,
      )) as any[];
    } catch (e) {
      console.log(`Error fetching underlyings for chain ${chain}:`, e);
      throw e;
    }

    await sleep(250);

    // Map results back to fork structure
    let resultIndex = 0;
    for (const { fork, markets, oracle } of forkMarketData) {
      const underlyingResults = secondBatchResults.slice(
        resultIndex,
        resultIndex + markets.length,
      );
      resultIndex += markets.length;

      // if the call fails, return address 0 as the underlying
      const currReserves = underlyingResults.map((result: any) => {
        const underlying = result?.result;
        return !underlying || underlying === "0x" ? zeroAddress : underlying;
      });

      // assign reserves
      reserves[fork][chain] = currReserves.map((r: any) => r.toLowerCase());
      oracles[fork][chain] = oracle;

      const dataOnChain = Object.assign(
        {},
        ...currReserves.map((a: any, i: number) => {
          return {
            [a.toLowerCase()]: markets[i].toLowerCase(),
          };
        }),
      );

      const dataArrayOnChain = currReserves.map(
        (underlying: any, i: number) => ({
          cToken: markets[i].toLowerCase(),
          underlying: underlying.toLowerCase(),
        }),
      );

      cTokens[fork][chain] = dataOnChain;
      cTokenArray[fork][chain] = dataArrayOnChain;
    }
  }

  return { cTokens, cTokenArray, reserves, COMPOUND_V2_COMPTROLLERS, oracles };
}
