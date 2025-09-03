import { getEvmClient } from "@1delta/providers";
import { INIT_ABIS, InitFetchFunctions } from "./abi.js";
import { readJsonFile } from "../utils/index.js";
// @ts-ignore
BigInt.prototype["toJSON"] = function () {
    return this.toString();
};
function uniqueStrings(arr) {
    return [...new Set(arr)];
}
const defaultModeSearch = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// aproach for init
// get mode configs for defaults
// fetch underlying per pool
// store maps
export async function fetchInitData() {
    let initDataMap = {};
    const INIT_CONFIG_PER_CHAIN_MAP = await readJsonFile("./config/init-pools.json");
    const forks = Object.keys(INIT_CONFIG_PER_CHAIN_MAP);
    for (const fork of forks) {
        initDataMap[fork] = {};
        const chains = Object.keys(INIT_CONFIG_PER_CHAIN_MAP[fork]);
        for (const chain of chains) {
            const initConfig = INIT_CONFIG_PER_CHAIN_MAP[fork][chain];
            const client = getEvmClient(chain);
            const poolsPerMode = (await client.multicall({
                allowFailure: false,
                contracts: defaultModeSearch.map((mode) => ({
                    abi: INIT_ABIS,
                    functionName: InitFetchFunctions.getModeConfig,
                    address: initConfig,
                    args: [mode],
                })),
            }));
            const allPools = uniqueStrings(defaultModeSearch.map((_, i) => poolsPerMode[i]?.[0]).flat());
            const allUnderlyings = (await client.multicall({
                allowFailure: false,
                contracts: allPools.map((pool) => ({
                    abi: INIT_ABIS,
                    functionName: InitFetchFunctions.underlyingToken,
                    address: pool,
                    args: [],
                })),
            }));
            const poolsToUnderlying = Object.assign({}, ...allPools.map((p, i) => {
                return { [p.toLowerCase()]: allUnderlyings[i].toLowerCase() };
            }));
            let modeData = {};
            let poolData = {};
            let pools = Object.keys(poolsToUnderlying);
            let reserves = Object.values(poolsToUnderlying);
            poolData = Object.assign({}, ...pools.map((p, i) => {
                return {
                    [p.toLowerCase()]: {
                        underlying: allUnderlyings[i].toLowerCase(),
                        modes: [],
                    },
                };
            }));
            for (let i = 0; i < defaultModeSearch.length; i++) {
                const mode = defaultModeSearch[i];
                let [collaterals, ,] = poolsPerMode[i];
                modeData[mode] = collaterals.map((c) => ({
                    pool: c,
                    underlying: poolsToUnderlying[c.toLowerCase()],
                }));
                collaterals.map((c) => {
                    poolData[c.toLowerCase()].modes.push(mode);
                });
            }
            initDataMap[fork][chain] = {
                poolData,
                poolsToUnderlying,
                reserves,
                modeData,
            };
        }
    }
    return { initDataMap, INIT_CONFIG_PER_CHAIN_MAP };
}
