import { COMET_ABIS, CompoundV3FetchFunctions } from "./abi.js";
import { readJsonFile } from "../utils/index.js";
import { multicallRetryUniversal } from "@1delta/providers";
import { sleep } from "../../utils.js";
// @ts-ignore
BigInt.prototype["toJSON"] = function () {
    return this.toString();
};
export async function fetchCompoundV3Data() {
    let cometDataMap = {};
    let cometOracles = {};
    let compoundReserves = {};
    let compoundBaseData = {};
    const COMETS_PER_CHAIN_MAP = await readJsonFile("./config/compound-v3-pools.json");
    const chains = Object.keys(COMETS_PER_CHAIN_MAP);
    for (const chain of chains) {
        try {
            const comets = Object.values(COMETS_PER_CHAIN_MAP[chain]);
            const cometMetaCalls = comets
                .map((comet) => [
                { address: comet, name: CompoundV3FetchFunctions.numAssets, args: [] },
                { address: comet, name: CompoundV3FetchFunctions.baseToken, args: [] },
                { address: comet, name: CompoundV3FetchFunctions.baseBorrowMin, args: [] },
                { address: comet, name: CompoundV3FetchFunctions.baseTokenPriceFeed, args: [] },
            ])
                .flat();
            const cometMetas = await multicallRetryUniversal({
                chain,
                calls: cometMetaCalls,
                abi: COMET_ABIS,
                allowFailure: false,
                maxRetries: 12,
            });
            const cometKeys = Object.keys(COMETS_PER_CHAIN_MAP[chain]);
            for (let i = 0; i < comets.length; i++) {
                try {
                    const comet = comets[i];
                    const metaSlice = cometMetas.slice(4 * i, 4 * i + 4);
                    const [numAssetsResult, baseAssetResult, baseBorrowMin, baseTokenFeed] = metaSlice;
                    if (numAssetsResult == null || !baseAssetResult) {
                        console.error(`Compound V3: missing meta for comet ${cometKeys[i]} on chain ${chain}, skipping`);
                        continue;
                    }
                    const nAssets = numAssetsResult;
                    const baseAsset = baseAssetResult.toLowerCase();
                    const cometIndexes = Array.from({ length: nAssets }, (_, j) => j);
                    await sleep(500);
                    const underlyingDatas = await multicallRetryUniversal({
                        chain,
                        calls: cometIndexes.map((j) => ({
                            address: comet,
                            name: CompoundV3FetchFunctions.getAssetInfo,
                            args: [j],
                        })),
                        abi: COMET_ABIS,
                        allowFailure: false,
                        maxRetries: 12,
                    });
                    const underlyings = [];
                    const pendingOracles = {};
                    for (const j of cometIndexes) {
                        const raw = underlyingDatas[j];
                        const asset = raw?.asset?.toLowerCase();
                        if (!asset)
                            continue;
                        underlyings.push(asset);
                        pendingOracles[asset] = raw?.priceFeed;
                    }
                    if (underlyings.length < nAssets) {
                        console.error(`Compound V3: incomplete asset data for comet ${cometKeys[i]} on chain ${chain} ` +
                            `(got ${underlyings.length}/${nAssets}), skipping to avoid overwriting existing data`);
                        continue;
                    }
                    if (!cometDataMap[cometKeys[i]])
                        cometDataMap[cometKeys[i]] = {};
                    if (!cometOracles[cometKeys[i]])
                        cometOracles[cometKeys[i]] = {};
                    if (!compoundBaseData[cometKeys[i]])
                        compoundBaseData[cometKeys[i]] = {};
                    if (!compoundReserves[cometKeys[i]])
                        compoundReserves[cometKeys[i]] = {};
                    cometOracles[cometKeys[i]][chain] = { ...pendingOracles, [baseAsset]: baseTokenFeed };
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
                catch (e) {
                    console.error(`Compound V3: failed to fetch comet ${cometKeys[i]} on chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
                }
            }
        }
        catch (e) {
            console.error(`Compound V3: failed to fetch chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
        }
    }
    return { compoundReserves, compoundBaseData, COMETS_PER_CHAIN_MAP, cometOracles };
}
