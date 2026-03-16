import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { readJsonFile } from "../utils/index.js";
import { multicallRetryUniversal } from "@1delta/providers";
import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { Lender } from "@1delta/lender-registry";

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

  const forks = Object.keys(COMPOUND_V2_COMPTROLLERS).filter(
    (f) => f !== Lender.COMPOUND_V2,
  );

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
    const firstBatchCalls = forksOnChain.flatMap(({ address, fork }) => [
      {
        address,
        name:
          fork === "UNITUS"
            ? "getAlliTokens"
            : CompoundV2FetchFunctions.getAllMarkets,
        args: [],
      },
      {
        address,
        name:
          fork === "UNITUS"
            ? "priceOracle"
            : CompoundV2FetchFunctions.oracle,
        args: [],
      },
    ]);

    let firstBatchResults: any[];
    try {
      firstBatchResults = await multicallRetryUniversal({
        chain,
        calls: firstBatchCalls,
        abi: COMPTROLLER_ABIS,
        allowFailure: true,
      });
    } catch (e: any) {
      console.error(`Error fetching markets for chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
      continue;
    }

    // Parse first batch results and prepare second batch
    const forkMarketData: {
      fork: string;
      markets: string[];
      oracle: string;
    }[] = [];

    for (let i = 0; i < forksOnChain.length; i++) {
      const { fork } = forksOnChain[i];
      const marketsResult = firstBatchResults[i * 2];
      const oracleResult = firstBatchResults[i * 2 + 1];

      if (!marketsResult || marketsResult === "0x") {
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
    const secondBatchCalls = forkMarketData.flatMap(({ markets }) =>
      markets.map((addr: string) => ({
        address: addr,
        name: CompoundV2FetchFunctions.underlying,
        args: [],
      })),
    );

    let secondBatchResults: any[];
    try {
      secondBatchResults = await multicallRetryUniversal({
        chain,
        calls: secondBatchCalls,
        abi: COMPTROLLER_ABIS,
        allowFailure: true,
      });
    } catch (e: any) {
      console.error(`Error fetching underlyings for chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
      continue;
    }

    await sleep(500);

    // Map results back to fork structure
    let resultIndex = 0;
    for (const { fork, markets, oracle } of forkMarketData) {
      const underlyingResults = secondBatchResults.slice(
        resultIndex,
        resultIndex + markets.length,
      );
      resultIndex += markets.length;

      const currReserves = underlyingResults.map((result: any) => {
        return !result || result === "0x" ? zeroAddress : result;
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
