import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { readJsonFile } from "../utils/index.js";
import { multicallRetryUniversal } from "@1delta/providers";
import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { Lender } from "@1delta/lender-registry";
import { fetchPauseFallback } from "./pause.js";
import { findNativeMarkets } from "./native.js";
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
        const firstBatchCalls = forksOnChain.flatMap(({ address, fork }) => [
            {
                address,
                name: fork === "UNITUS"
                    ? "getAlliTokens"
                    : CompoundV2FetchFunctions.getAllMarkets,
                args: [],
            },
            {
                address,
                name: fork === "UNITUS"
                    ? "priceOracle"
                    : CompoundV2FetchFunctions.oracle,
                args: [],
            },
        ]);
        let firstBatchResults;
        try {
            firstBatchResults = await multicallRetryUniversal({
                chain,
                calls: firstBatchCalls,
                abi: COMPTROLLER_ABIS,
                allowFailure: true,
            });
        }
        catch (e) {
            console.error(`Error fetching markets for chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
            continue;
        }
        // Parse first batch results and prepare second batch
        const forkMarketData = [];
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
        if (forkMarketData.length === 0)
            continue;
        // BATCH CALL 2: Get all underlyings for all cTokens across all forks on this chain
        const secondBatchCalls = forkMarketData.flatMap(({ markets }) => markets.map((addr) => ({
            address: addr,
            name: CompoundV2FetchFunctions.underlying,
            args: [],
        })));
        let secondBatchResults;
        try {
            secondBatchResults = await multicallRetryUniversal({
                chain,
                calls: secondBatchCalls,
                abi: COMPTROLLER_ABIS,
                allowFailure: true,
            });
        }
        catch (e) {
            console.error(`Error fetching underlyings for chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
            continue;
        }
        await sleep(500);
        // Map results back to fork structure
        let resultIndex = 0;
        for (const { fork, markets, oracle } of forkMarketData) {
            const underlyingResults = secondBatchResults.slice(resultIndex, resultIndex + markets.length);
            resultIndex += markets.length;
            const currReserves = underlyingResults.map((result) => {
                return !result || result === "0x" ? zeroAddress : result;
            });
            // `underlying()` reverting is the usual native-market tell, but it is not
            // the only shape: a few forks ship a CEther-style market that ANSWERS
            // `underlying()` with the wrapped token (FILDA fBNB/fIOTX, BASIC bIOTX,
            // ENZO eBTC). Published with that underlying they take the ERC-20
            // deposit branch, whose `mint(uint256)` these delegators swallow SILENTLY
            // — a status-1 transaction that mints nothing. Probe the entry point and
            // correct the row. See ./native.ts for why only an empty success counts,
            // and why an unreachable probe must change nothing.
            const nativeOverrides = await findNativeMarkets(chain, markets.filter((_, i) => currReserves[i].toLowerCase() !== zeroAddress));
            if (nativeOverrides.size > 0) {
                console.log(`  ${fork} on ${chain}: ${nativeOverrides.size} native market(s) reported a wrapped underlying — corrected to the zero address`);
                for (let i = 0; i < markets.length; i++) {
                    if (nativeOverrides.has(markets[i].toLowerCase()))
                        currReserves[i] = zeroAddress;
                }
            }
            // assign reserves
            reserves[fork][chain] = currReserves.map((r) => r.toLowerCase());
            oracles[fork][chain] = oracle;
            const dataOnChain = Object.assign({}, ...currReserves.map((a, i) => {
                return {
                    [a.toLowerCase()]: markets[i].toLowerCase(),
                };
            }));
            // Pause flags, but ONLY for a Comptroller with no guardian getters —
            // everywhere else the fetcher reads them live and a published copy would
            // just go stale. See ./pause.ts for how they are resolved.
            const comptroller = COMPOUND_V2_COMPTROLLERS[fork]?.[chain];
            const pause = comptroller
                ? await fetchPauseFallback(chain, comptroller, markets)
                : undefined;
            if (pause)
                console.log(`  ${fork} on ${chain}: no pause getters — resolved ${Object.keys(pause).length} markets by simulation`);
            const dataArrayOnChain = currReserves.map((underlying, i) => {
                const cToken = markets[i].toLowerCase();
                const flags = pause?.[cToken];
                return {
                    cToken,
                    underlying: underlying.toLowerCase(),
                    ...(flags
                        ? {
                            mintPaused: flags.mintPaused,
                            borrowPaused: flags.borrowPaused,
                        }
                        : {}),
                };
            });
            cTokens[fork][chain] = dataOnChain;
            cTokenArray[fork][chain] = dataArrayOnChain;
        }
    }
    return { cTokens, cTokenArray, reserves, COMPOUND_V2_COMPTROLLERS, oracles };
}
