// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index
import { COMPOUND_V2_COMPTROLLERS } from "@1delta/asset-registry";
import { getEvmClient } from "@1delta/providers";
import { COMPTROLLER_ABIS, CompoundV2FetchFunctions } from "./abi.js";
// aproach for compound V2
// get cToken list from pool
// fetch underlying per cToken
// store maps
export async function fetchCompoundV2TypeTokenData() {
    const forks = Object.keys(COMPOUND_V2_COMPTROLLERS);
    let cTokens = {};
    let reserves = {};
    for (const fork of forks) {
        // @ts-ignore
        const addressSet = COMPOUND_V2_COMPTROLLERS[fork];
        const chains = Object.keys(addressSet);
        let dataMap = {};
        reserves[fork] = {};
        for (const chain of chains) {
            const client = getEvmClient(chain);
            const address = addressSet[chain];
            let data;
            console.log("fetching for", chain, fork);
            try {
                const [DataMarkets] = (await client.multicall({
                    allowFailure: false,
                    contracts: [
                        {
                            abi: COMPTROLLER_ABIS,
                            functionName: CompoundV2FetchFunctions.getAllMarkets,
                            address: address,
                            args: [],
                        },
                    ],
                }));
                data = DataMarkets;
            }
            catch (e) {
                throw e;
            }
            const underlyingCalls = data.map((addr) => ({
                abi: COMPTROLLER_ABIS,
                functionName: CompoundV2FetchFunctions.underlying,
                address: addr,
                args: [],
            }));
            // set allowFailure to true to prevent the entire call from failing for tokens that do not have an underlying function
            const underlyingResults = (await client.multicall({
                allowFailure: true,
                contracts: underlyingCalls,
            }));
            // if the call fails, return address 0 as the underlying
            const Reserves = underlyingResults.map((result) => {
                if (result.status === "failure") {
                    return "0x0000000000000000000000000000000000000000";
                }
                return result.result;
            });
            // assign reserves
            reserves[fork][chain] = Reserves.map((r) => r.toLowerCase());
            const dataOnChain = Object.assign({}, ...Reserves.map((a, i) => {
                return {
                    [a.toLowerCase()]: data[i].toLowerCase(),
                };
            }));
            dataMap[chain] = dataOnChain;
        }
        cTokens[fork] = dataMap;
        dataMap = {};
    }
    return { cTokens, reserves };
}
