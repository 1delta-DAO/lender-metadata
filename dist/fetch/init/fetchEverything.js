import { multicallRetryUniversal } from "@1delta/providers";
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
            const poolsPerMode = await multicallRetryUniversal({
                chain,
                calls: defaultModeSearch.map((mode) => ({
                    address: initConfig,
                    name: InitFetchFunctions.getModeConfig,
                    args: [mode],
                })),
                abi: INIT_ABIS,
                allowFailure: false,
            });
            const allPools = uniqueStrings(defaultModeSearch.map((_, i) => poolsPerMode[i]?.[0]).flat());
            const allUnderlyings = await multicallRetryUniversal({
                chain,
                calls: allPools.map((pool) => ({
                    address: pool,
                    name: InitFetchFunctions.underlyingToken,
                    args: [],
                })),
                abi: INIT_ABIS,
                allowFailure: false,
            });
            const poolEntryMap = {};
            for (let i = 0; i < allPools.length; i++) {
                const pool = allPools[i].toLowerCase();
                poolEntryMap[pool] = {
                    pool,
                    underlying: allUnderlyings[i].toLowerCase(),
                    modes: [],
                };
            }
            for (let i = 0; i < defaultModeSearch.length; i++) {
                const mode = defaultModeSearch[i];
                let [collaterals, ,] = poolsPerMode[i];
                collaterals.forEach((c) => {
                    poolEntryMap[c.toLowerCase()].modes.push(mode);
                });
            }
            initDataMap[fork][chain] = Object.values(poolEntryMap);
        }
    }
    return { initDataMap, INIT_CONFIG_PER_CHAIN_MAP };
}
