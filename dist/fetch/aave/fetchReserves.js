import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { AAVE_FORK_POOL_DATA, Lender } from "@1delta/asset-registry";
import { getEvmClient } from "@1delta/providers";
const forkHasNoSToken = (ledner) => ledner === Lender.YLDR;
// aproach for aave
// get reserve list from pool
// fetch tokens per reserve from address provider
// store maps
export async function fetchAaveTypeTokenData() {
    const forks = Object.keys(AAVE_FORK_POOL_DATA);
    let forkMap = {};
    let reservesMap = {};
    for (const fork of forks) {
        // @ts-ignore
        const addressSet = AAVE_FORK_POOL_DATA[fork];
        const chains = Object.keys(addressSet);
        let dataMap = {};
        reservesMap[fork] = {};
        const hasNoSToken = forkHasNoSToken(fork);
        for (const chain of chains) {
            const client = getEvmClient(chain);
            const addresses = addressSet[chain];
            let data;
            console.log("fetching for", chain, fork);
            try {
                const [DataReserves] = (await client.multicall({
                    allowFailure: false,
                    contracts: [
                        {
                            abi: AAVE_ABIS(hasNoSToken),
                            functionName: AaveFetchFunctions.getReservesList,
                            address: addresses.pool,
                            args: [],
                        },
                    ],
                }));
                data = DataReserves;
                await sleep(250);
            }
            catch (e) {
                throw e;
            }
            // assign reserves
            reservesMap[fork][chain] = data;
            const AaveLenderTokens = (await client.multicall({
                allowFailure: false,
                contracts: data.map((addr) => ({
                    abi: AAVE_ABIS(hasNoSToken),
                    functionName: AaveFetchFunctions.getReserveTokensAddresses,
                    address: addresses.protocolDataProvider,
                    args: [addr],
                })),
            }));
            await sleep(250);
            const dataOnChain = hasNoSToken
                ? Object.assign({}, ...data.map((a, i) => {
                    return {
                        [a.toLowerCase()]: {
                            aToken: AaveLenderTokens[i][0]?.toLowerCase(),
                            vToken: AaveLenderTokens[i][1]?.toLowerCase(),
                            sToken: zeroAddress,
                        },
                    };
                }))
                : Object.assign({}, ...data.map((a, i) => {
                    return {
                        [a.toLowerCase()]: {
                            aToken: AaveLenderTokens[i][0]?.toLowerCase(),
                            sToken: AaveLenderTokens[i][1]?.toLowerCase(),
                            vToken: AaveLenderTokens[i][2]?.toLowerCase(),
                        },
                    };
                }));
            dataMap[chain] = dataOnChain;
        }
        forkMap[fork] = dataMap;
        dataMap = {};
    }
    return { tokens: forkMap, reserves: reservesMap };
}
