// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index
import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { multicallRetry, readJsonFile } from "../utils/index.js";
import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { Lender } from "@1delta/lender-registry";
// aproach for compound V2
// get cToken list from pool
// fetch underlying per cToken
// store maps
export async function fetchCompoundV2TypeTokenData() {
    const COMPOUND_V2_COMPTROLLERS = await readJsonFile("./config/compound-v2-pools.json");
    const forks = Object.keys(COMPOUND_V2_COMPTROLLERS).filter((f) => f !== Lender.COMPOUND_V2);
    const cTokens = {};
    const oracles = {};
    const cTokenArray = {};
    const reserves = {};
    // Initialize empty structures for all forks
    for (const fork of forks) {
        cTokens[fork] = {};
        cTokenArray[fork] = {};
        reserves[fork] = {};
        oracles[fork] = {};
    }
    // Group all (fork, chain, address) tuples by chain
    const chainToForks = {};
    for (const fork of forks) {
        const addressSet = COMPOUND_V2_COMPTROLLERS[fork];
        const chains = Object.keys(addressSet);
        for (const chain of chains) {
            if (!chainToForks[chain])
                chainToForks[chain] = [];
            chainToForks[chain].push({ fork, address: addressSet[chain] });
        }
    }
    // Process each chain with batched multicalls
    for (const chain of Object.keys(chainToForks)) {
        const forksOnChain = chainToForks[chain];
        console.log(`fetching for chain ${chain}, forks: ${forksOnChain.map((f) => f.fork).join(", ")}`);
        // BATCH CALL 1: Get all markets and oracles for all forks on this chain
        const firstBatchContracts = forksOnChain.flatMap(({ address, fork }) => [
            {
                abi: COMPTROLLER_ABIS,
                functionName: fork === "UNITUS"
                    ? "getAlliTokens"
                    : CompoundV2FetchFunctions.getAllMarkets,
                address: address,
                args: [],
            },
            {
                abi: COMPTROLLER_ABIS,
                functionName: fork === "UNITUS"
                    ? "priceOracle"
                    : CompoundV2FetchFunctions.oracle,
                address: address,
                args: [],
            },
        ]);
        let firstBatchResults;
        try {
            firstBatchResults = (await multicallRetry({
                chainId: chain,
                allowFailure: true,
                contracts: firstBatchContracts,
            }, 6));
        }
        catch (e) {
            console.log(`Error fetching markets for chain ${chain}:`, e);
            throw e;
        }
        // Parse first batch results and prepare second batch
        const forkMarketData = [];
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
        if (forkMarketData.length === 0)
            continue;
        // BATCH CALL 2: Get all underlyings for all cTokens across all forks on this chain
        const secondBatchContracts = forkMarketData.flatMap(({ markets }) => markets.map((addr) => ({
            abi: COMPTROLLER_ABIS,
            functionName: CompoundV2FetchFunctions.underlying,
            address: addr,
            args: [],
        })));
        let secondBatchResults;
        try {
            secondBatchResults = (await multicallRetry({
                chainId: chain,
                allowFailure: true,
                contracts: secondBatchContracts,
            }, 6));
        }
        catch (e) {
            console.log(`Error fetching underlyings for chain ${chain}:`, e);
            throw e;
        }
        await sleep(500);
        // Map results back to fork structure
        let resultIndex = 0;
        for (const { fork, markets, oracle } of forkMarketData) {
            const underlyingResults = secondBatchResults.slice(resultIndex, resultIndex + markets.length);
            resultIndex += markets.length;
            // if the call fails, return address 0 as the underlying
            const currReserves = underlyingResults.map((result) => {
                const underlying = result?.result;
                return !underlying || underlying === "0x" ? zeroAddress : underlying;
            });
            // assign reserves
            reserves[fork][chain] = currReserves.map((r) => r.toLowerCase());
            oracles[fork][chain] = oracle;
            const dataOnChain = Object.assign({}, ...currReserves.map((a, i) => {
                return {
                    [a.toLowerCase()]: markets[i].toLowerCase(),
                };
            }));
            const dataArrayOnChain = currReserves.map((underlying, i) => ({
                cToken: markets[i].toLowerCase(),
                underlying: underlying.toLowerCase(),
            }));
            cTokens[fork][chain] = dataOnChain;
            cTokenArray[fork][chain] = dataArrayOnChain;
        }
    }
    return { cTokens, cTokenArray, reserves, COMPOUND_V2_COMPTROLLERS, oracles };
}
