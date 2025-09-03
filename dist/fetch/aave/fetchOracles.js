import { getEvmClientWithCustomRpcs } from "@1delta/providers";
import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { sleep } from "../../utils.js";
// aproach for aave
// get reserve list from pool
// fetch tokens per reserve from address provider
// store maps
export async function fetchAaveTypePriceOracles(AAVE_FORK_POOL_DATA) {
    const forks = Object.keys(AAVE_FORK_POOL_DATA);
    let forkMap = {};
    for (const fork of forks) {
        // @ts-ignore
        const addressSet = AAVE_FORK_POOL_DATA[fork];
        const chains = Object.keys(addressSet);
        let dataMap = {};
        for (const chain of chains) {
            const client = getEvmClientWithCustomRpcs(chain);
            const addresses = addressSet[chain];
            console.log("fetching for", chain, fork);
            let aProvider = "0x";
            try {
                const [addressProvider] = (await client.multicall({
                    allowFailure: false,
                    contracts: [
                        {
                            abi: AAVE_ABIS(false),
                            functionName: AaveFetchFunctions.ADDRESSES_PROVIDER,
                            address: addresses.protocolDataProvider,
                            args: [],
                        },
                    ],
                }));
                aProvider = addressProvider;
                await sleep(250);
            }
            catch (e) {
                // throw e
                continue;
            }
            // assign reserves
            const [oracleAddress] = (await client.multicall({
                allowFailure: false,
                contracts: [
                    {
                        abi: AAVE_ABIS(false),
                        functionName: AaveFetchFunctions.getPriceOracle,
                        address: aProvider,
                        args: [],
                    },
                ],
            }));
            await sleep(250);
            dataMap[chain] = oracleAddress;
        }
        forkMap[fork] = dataMap;
        dataMap = {};
    }
    return forkMap;
}
