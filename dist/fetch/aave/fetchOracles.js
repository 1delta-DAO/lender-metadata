import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { sleep } from "../../utils.js";
import { Lender } from "@1delta/lender-registry";
import { Chain } from "@1delta/chain-registry";
import { multicallRetry } from "../utils/index.js";
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
        if (fork === Lender.KLAYBANK) {
            forkMap[Lender.KLAYBANK] = {
                [Chain.KAIA_MAINNET]: "0xa4BCd83C6d6C75ED9E029cde2DD24bAc2f3C5B59",
            };
            continue;
        }
        for (const chain of chains) {
            const addresses = addressSet[chain];
            console.log("fetching for", chain, fork);
            let aProvider = "0x";
            try {
                const [addressProvider] = (await multicallRetry({
                    chainId: chain,
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
            const [oracleAddress] = (await multicallRetry({
                chainId: chain,
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
