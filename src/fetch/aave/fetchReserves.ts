import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { Lender } from "@1delta/lender-registry";
import { multicallRetry, readJsonFile } from "../utils/index.js";

interface AaveTokens {
  aToken: string;
  sToken: string;
  vToken: string;
}

type AaveMap = { [chainId: string]: { [address: string]: AaveTokens } };

type AaveForkMap = { [fork: string]: AaveMap };

type ReservesMap = { [fork: string]: { [chain: string | number]: string[] } };

const forkHasNoSToken = (ledner: String) => ledner === Lender.YLDR;

// aproach for aave
// get reserve list from pool
// fetch tokens per reserve from address provider
// store maps
export async function fetchAaveTypeTokenData(): Promise<{
  tokens: AaveForkMap;
  reserves: ReservesMap;
  AAVE_FORK_POOL_DATA: any;
}> {
  const AAVE_FORK_POOL_DATA = await readJsonFile("./config/aave-pools.json");
  const forks = Object.keys(AAVE_FORK_POOL_DATA);

  const forkMap: AaveForkMap = {};
  const reservesMap: ReservesMap = {};

  // Initialize empty structures for all forks
  for (const fork of forks) {
    forkMap[fork] = {};
    reservesMap[fork] = {};
  }

  // Group all (fork, chain, addresses, hasNoSToken) tuples by chain
  const chainToForks: {
    [chain: string]: {
      fork: string;
      addresses: { pool: string; protocolDataProvider: string };
      hasNoSToken: boolean;
    }[];
  } = {};

  for (const fork of forks) {
    const addressSet = AAVE_FORK_POOL_DATA[fork];
    const chains = Object.keys(addressSet);
    const hasNoSToken = forkHasNoSToken(fork);
    for (const chain of chains) {
      if (!chainToForks[chain]) chainToForks[chain] = [];
      chainToForks[chain].push({
        fork,
        addresses: addressSet[chain],
        hasNoSToken,
      });
    }
  }

  // Process each chain with batched multicalls
  for (const chain of Object.keys(chainToForks)) {
    const forksOnChain = chainToForks[chain];
    console.log(
      `fetching for chain ${chain}, forks: ${forksOnChain.map((f) => f.fork).join(", ")}`,
    );

    // BATCH CALL 1: Get all reserve lists for all forks on this chain
    const firstBatchContracts = forksOnChain.map(
      ({ addresses, hasNoSToken }) => ({
        abi: AAVE_ABIS(hasNoSToken),
        functionName: AaveFetchFunctions.getReservesList,
        address: addresses.pool as any,
        args: [],
      }),
    );

    let firstBatchResults: any[];
    try {
      firstBatchResults = (await multicallRetry({
        chainId: chain,
        allowFailure: true,
        contracts: firstBatchContracts,
      })) as any[];
    } catch (e: any) {
      console.log(`Error fetching reserves for chain ${chain}:`, e);
      throw e;
    }

    await sleep(250);

    // Parse first batch results and prepare second batch
    const forkReserveData: {
      fork: string;
      reserves: string[];
      protocolDataProvider: string;
      hasNoSToken: boolean;
    }[] = [];

    for (let i = 0; i < forksOnChain.length; i++) {
      const { fork, addresses, hasNoSToken } = forksOnChain[i];
      const reservesResult = firstBatchResults[i]?.result ?? firstBatchResults[i];

      if (!reservesResult || !Array.isArray(reservesResult)) {
        console.log(`No reserves found for ${fork} on chain ${chain}`);
        continue;
      }

      forkReserveData.push({
        fork,
        reserves: reservesResult,
        protocolDataProvider: addresses.protocolDataProvider,
        hasNoSToken,
      });
    }

    if (forkReserveData.length === 0) continue;

    // BATCH CALL 2: Get all token addresses for all reserves across all forks on this chain
    const secondBatchContracts = forkReserveData.flatMap(
      ({ reserves, protocolDataProvider, hasNoSToken }) =>
        reserves.map((addr: string) => ({
          abi: AAVE_ABIS(hasNoSToken),
          functionName: AaveFetchFunctions.getReserveTokensAddresses,
          address: protocolDataProvider as any,
          args: [addr],
        })),
    );

    let secondBatchResults: any[];
    try {
      secondBatchResults = (await multicallRetry({
        chainId: chain,
        allowFailure: true,
        contracts: secondBatchContracts,
      })) as any[];
    } catch (e) {
      console.log(`Error fetching token addresses for chain ${chain}:`, e);
      throw e;
    }

    await sleep(250);

    // Map results back to fork structure
    let resultIndex = 0;
    for (const { fork, reserves, hasNoSToken } of forkReserveData) {
      const tokenResults = secondBatchResults.slice(
        resultIndex,
        resultIndex + reserves.length,
      );
      resultIndex += reserves.length;

      // assign reserves
      reservesMap[fork][chain] = reserves.map((r: any) => r.toLowerCase());

      const dataOnChain = hasNoSToken
        ? Object.assign(
            {},
            ...reserves.map((a: any, i: number) => {
              const result = tokenResults[i]?.result ?? tokenResults[i];
              return {
                [a.toLowerCase()]: {
                  aToken: result?.[0]?.toLowerCase(),
                  vToken: result?.[1]?.toLowerCase(),
                  sToken: zeroAddress,
                },
              };
            }),
          )
        : Object.assign(
            {},
            ...reserves.map((a: any, i: number) => {
              const result = tokenResults[i]?.result ?? tokenResults[i];
              return {
                [a.toLowerCase()]: {
                  aToken: result?.[0]?.toLowerCase(),
                  sToken: result?.[1]?.toLowerCase(),
                  vToken: result?.[2]?.toLowerCase(),
                },
              };
            }),
          );

      forkMap[fork][chain] = dataOnChain;
    }
  }

  return { tokens: forkMap, reserves: reservesMap, AAVE_FORK_POOL_DATA };
}
