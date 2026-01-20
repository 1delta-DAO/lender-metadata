// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index
import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
import { multicallRetry, readJsonFile } from "../utils/index.js";
import { zeroAddress } from "viem";
// aproach for compound V2
// get cToken list from pool
// fetch underlying per cToken
// store maps
export async function fetchCompoundV2TypeTokenData() {
    const COMPOUND_V2_COMPTROLLERS = await readJsonFile("./config/compound-v2-pools.json");
    const forks = Object.keys(COMPOUND_V2_COMPTROLLERS);
    let cTokens = {};
    let cTokenArray = {};
    let reserves = {};
    for (const fork of forks) {
        // @ts-ignore
        const addressSet = COMPOUND_V2_COMPTROLLERS[fork];
        const chains = Object.keys(addressSet);
        let dataMap = {};
        let dataArray = {};
        reserves[fork] = {};
        for (const chain of chains) {
            const address = addressSet[chain];
            let data;
            console.log("fetching for", chain, fork);
            try {
                const [marketsData] = (await multicallRetry({
                    chainId: chain,
                    allowFailure: true,
                    contracts: [
                        {
                            abi: COMPTROLLER_ABIS,
                            functionName: CompoundV2FetchFunctions.getAllMarkets,
                            address: address,
                            args: [],
                        },
                    ],
                }, 5));
                data = marketsData.result;
            }
            catch (e) {
                throw e;
            }
            if (!data)
                continue;
            const underlyingCalls = data.map((addr) => ({
                abi: COMPTROLLER_ABIS,
                functionName: CompoundV2FetchFunctions.underlying,
                address: addr,
                args: [],
            }));
            // set allowFailure to true to prevent the entire call from failing for tokens that do not have an underlying function
            const underlyingResults = (await multicallRetry({
                chainId: chain,
                allowFailure: true,
                contracts: underlyingCalls,
            }, 5));
            // if the call fails, return address 0 as the underlying
            const currReserves = underlyingResults.map((result) => {
                return result?.result ?? zeroAddress;
            });
            // assign reserves
            reserves[fork][chain] = currReserves.map((r) => r.toLowerCase());
            const dataOnChain = Object.assign({}, ...currReserves.map((a, i) => {
                return {
                    [a.toLowerCase()]: data[i].toLowerCase(),
                };
            }));
            const dataArrayOnChain = currReserves.map((underlying, i) => ({
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
