// ============================================================================
// Data Updaters
// ============================================================================
import { DEFAULTS, DEFAULTS_SHORT } from "../defaults.js";
import { mergeData, numberToBps } from "../../utils.js";
import { readJsonFile } from "../utils/index.js";
import { Chain } from "@1delta/chain-registry";
import { getMarketsOnChain } from "./fetchMorphoOnChain.js";
const labelsFile = "./data/lender-labels.json";
const oraclesFile = "./data/morpho-oracles.json";
const poolsFile = "./config/morpho-pools.json";
const curatorsFile = "./data/morpho-curators.json";
const cannotUseApi = (chainId, fork) => {
    if (fork === "MORPHO_BLUE") {
        return chainId === Chain.OP_MAINNET || chainId === Chain.HEMI_NETWORK || chainId === Chain.SONEIUM;
    }
    return true; // can't use api for moolah
};
/**
 * Merges old and new data maps based on unique combinations of loanAsset and collateralAsset
 * @param {Object} oldDataMap - The old data map with chainId keys
 * @param {Object} newDataMap - The new data map with chainId keys
 * @returns {Object} Merged data map with new data taking precedence
 */
function mergeOracleDataMaps(oldDataMap, newDataMap) {
    const merged = {};
    // Get all unique chain IDs from both maps
    const allChainIds = new Set([...Object.keys(oldDataMap || {}), ...Object.keys(newDataMap || {})]);
    for (const chainId of allChainIds) {
        const oldEntries = oldDataMap[chainId] || [];
        const newEntries = newDataMap[chainId] || [];
        // Create a map for quick lookup using loanAsset + collateralAsset as key
        const entryMap = new Map();
        // Add old entries first
        for (const entry of oldEntries) {
            const key = `${entry.loanAsset}-${entry.collateralAsset}`;
            entryMap.set(key, entry);
        }
        // Add new entries (will overwrite old ones with same key)
        for (const entry of newEntries) {
            const key = `${entry.loanAsset}-${entry.collateralAsset}`;
            entryMap.set(key, entry);
        }
        // Convert back to array and sort for consistency
        merged[chainId] = Array.from(entryMap.values()).sort((a, b) => {
            // Sort by loanAsset first, then by collateralAsset
            if (a.loanAsset !== b.loanAsset) {
                return a.loanAsset.localeCompare(b.loanAsset);
            }
            return a.collateralAsset.localeCompare(b.collateralAsset);
        });
    }
    return merged;
}
export class MorphoBlueUpdater {
    name = "Morpho Blue Markets";
    // to-do: add this to supplyingVaults.state and check the market.id and calculate correctly
    // allocation {
    //   supplyAssets
    //   supplyAssetsUsd
    //   market {
    //     id
    //   }
    // }
    query(first, skip, chainId) {
        return `
    query GetMarkets {
      markets(first: ${first}, skip: ${skip}, where:  {
         chainId_in: [${chainId}],
         whitelisted: true
      },
      orderBy: SupplyAssetsUsd,   
      orderDirection: Desc
      ) {
        items {
          id
          uniqueKey
          lltv
          oracleAddress
          loanAsset {
            address
            symbol
            decimals
          }
          collateralAsset {
            address
            symbol
            decimals
          }
          supplyingVaults {
            state {
              curators {
                id,
                image,
                verified,
                name
              }
            }
          }
        }
      }
    }
    `;
    }
    async fetchMorphoMarkets(chainId) {
        const BASE_URL = "https://blue-api.morpho.org/graphql";
        const requestBody = {
            query: this.query(200, 0, chainId),
            variables: {},
        };
        const response = await fetch(BASE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
            throw new Error(`Network error: ${response.status} - ${response.statusText}`);
        }
        const data = await response.json();
        return data.data;
    }
    async fetchData() {
        const chainids = ["1", "10", "56", "137", "999", "1868", "8453", "43111", "42161", "747474"];
        const MORPHO_BLUE_POOL_DATA = await readJsonFile(poolsFile);
        const forks = Object.keys(MORPHO_BLUE_POOL_DATA);
        const names = {};
        const shortNames = {};
        const oracles = {};
        const curators = {};
        for (const fork of forks) {
            const forkConfig = MORPHO_BLUE_POOL_DATA[fork];
            for (const chainId of chainids) {
                if (!forkConfig[chainId])
                    continue;
                let marketData;
                if (cannotUseApi(chainId, fork)) {
                    marketData = await getMarketsOnChain(chainId, { [fork]: forkConfig });
                }
                else {
                    marketData = await this.fetchMorphoMarkets(chainId);
                }
                const items = marketData.markets?.items || [];
                for (const el of items) {
                    const hash = el.uniqueKey;
                    const enumName = `${fork}_${hash.slice(2).toUpperCase()}`;
                    if (!oracles[chainId])
                        oracles[chainId] = [];
                    const oracle = el.oracleAddress;
                    const loanAsset = el.loanAsset.address.toLowerCase();
                    const collateralAsset = el.collateralAsset?.address.toLowerCase();
                    const loanAssetDecimals = el.loanAsset.decimals;
                    const collateralAssetDecimals = el.collateralAsset?.decimals;
                    if (collateralAsset && loanAsset && oracle !== "0x0000000000000000000000000000000000000000") {
                        oracles[chainId].push({
                            oracle,
                            loanAsset,
                            collateralAsset,
                            loanAssetDecimals,
                            collateralAssetDecimals,
                        });
                    }
                    const loanSym = el.loanAsset?.symbol;
                    const collSym = el.collateralAsset?.symbol;
                    if (!loanSym || !collSym)
                        continue;
                    const bps = numberToBps(el.lltv);
                    const protocolPrefix = fork === "MOOLAH" ? "Moolah" : "Morpho";
                    const shortPrefix = fork === "MOOLAH" ? "ML" : "MB";
                    const longName = `${protocolPrefix} ${collSym}-${loanSym} ${bps}`;
                    const shortName = `${shortPrefix} ${collSym}-${loanSym} ${bps}`;
                    names[enumName] = longName;
                    shortNames[enumName] = shortName;
                    // curators
                    if (!!el.supplyingVaults && el.supplyingVaults.length > 0) {
                        if (!curators[chainId])
                            curators[chainId] = {};
                        const uniqueCuratorList = Array.from(new Map(el.supplyingVaults.flatMap((vault) => vault?.state?.curators || []).map((curator) => [curator.id, curator])).values());
                        curators[chainId][enumName] = uniqueCuratorList;
                    }
                }
            }
        }
        return {
            [labelsFile]: { names, shortNames },
            [oraclesFile]: oracles,
            [poolsFile]: MORPHO_BLUE_POOL_DATA,
            [curatorsFile]: curators,
        };
    }
    mergeData(oldData, data, fileKey) {
        if (fileKey === labelsFile) {
            return mergeData(oldData, data, this.defaults[labelsFile]);
        }
        if (fileKey === oraclesFile) {
            return mergeOracleDataMaps(data, this.defaults[oraclesFile]);
        }
        if (fileKey === poolsFile) {
            return data;
        }
        if (fileKey === curatorsFile) {
            return mergeData(oldData, data, this.defaults[curatorsFile]);
        }
        throw new Error("Bad File");
    }
    defaults = {
        [labelsFile]: { names: DEFAULTS, shortNames: DEFAULTS_SHORT },
        [oraclesFile]: {},
        [curatorsFile]: {},
    };
}
