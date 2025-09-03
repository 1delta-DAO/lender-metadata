// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index
import { COMET_ABIS, CompoundV3FetchFunctions } from "./abi.js";
import { getEvmClientWithCustomRpcs } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
// @ts-ignore
BigInt.prototype["toJSON"] = function () {
    return this.toString();
};
// store maps
export async function fetchCompoundV3Data() {
    let cometDataMap = {};
    let compoundReserves = {};
    let compoundBaseData = {};
    const COMETS_PER_CHAIN_MAP = await readJsonFile("./config/compound-v3-pools.json");
    const chains = Object.keys(COMETS_PER_CHAIN_MAP);
    for (const chain of chains) {
        const comets = Object.values(COMETS_PER_CHAIN_MAP[chain]);
        const client = getEvmClientWithCustomRpcs(chain);
        const CometMetas = (await client.multicall({
            allowFailure: false,
            contracts: comets
                .map((comet) => [
                {
                    abi: COMET_ABIS,
                    functionName: CompoundV3FetchFunctions.numAssets,
                    address: comet,
                    args: [],
                },
                {
                    abi: COMET_ABIS,
                    functionName: CompoundV3FetchFunctions.baseToken,
                    address: comet,
                    args: [],
                },
                {
                    abi: COMET_ABIS,
                    functionName: CompoundV3FetchFunctions.baseBorrowMin,
                    address: comet,
                    args: [],
                },
            ])
                .flat(),
        }));
        const cometKeys = Object.keys(COMETS_PER_CHAIN_MAP[chain]);
        for (let i = 0; i < comets.length; i++) {
            const comet = comets[i];
            const [numAssetsesult, baseAssetResult, baseBorrowMin] = CometMetas.slice(3 * i, 3 * i + 3);
            const nAssets = numAssetsesult;
            const baseAsset = baseAssetResult.toLowerCase();
            const cometIndexes = Array.from({ length: nAssets }, (_, i) => i);
            const underlyingDatas = (await client.multicall({
                allowFailure: false,
                contracts: cometIndexes.map((i) => ({
                    abi: COMET_ABIS,
                    functionName: CompoundV3FetchFunctions.getAssetInfo,
                    address: comet,
                    args: [i],
                })),
            }));
            const underlyings = cometIndexes.map((i) => underlyingDatas[i].asset.toLowerCase());
            if (!cometDataMap[cometKeys[i]])
                cometDataMap[cometKeys[i]] = {};
            if (!compoundBaseData[cometKeys[i]])
                compoundBaseData[cometKeys[i]] = {};
            if (!compoundReserves[cometKeys[i]])
                compoundReserves[cometKeys[i]] = {};
            compoundReserves[cometKeys[i]][chain] = [baseAsset, ...underlyings].map((r) => r.toLowerCase());
            compoundBaseData[cometKeys[i]][chain] = { baseAsset, baseBorrowMin };
            cometDataMap[cometKeys[i]][chain] = {
                baseAsset,
                baseBorrowMin,
                baseAsetSymbol: cometKeys[i],
                reserves: [baseAsset, ...underlyings],
                nAssets,
            };
        }
    }
    return { compoundReserves, compoundBaseData, COMETS_PER_CHAIN_MAP };
}
