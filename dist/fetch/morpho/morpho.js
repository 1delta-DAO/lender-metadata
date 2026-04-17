// ============================================================================
// Data Updaters
// ============================================================================
import { DEFAULTS, DEFAULTS_SHORT } from "../defaults.js";
import { mergeData, numberToBps } from "../../utils.js";
import { readJsonFile } from "../utils/index.js";
import { Chain } from "@1delta/chain-registry";
import { getMarketsOnChain } from "./fetchMorphoOnChain.js";
import { hasSubgraph, fetchMarketsFromSubgraph, } from "./fetchMorphoSubgraph.js";
import { Lender } from "@1delta/lender-registry";
import { computeMorphoMarketId } from "./morphoMarketId.js";
const labelsFile = "./data/lender-labels.json";
const oraclesFile = "./data/morpho-type-oracles.json";
const poolsFile = "./config/morpho-pools.json";
const marketsFile = "./config/morpho-type-markets.json";
const curatorsFile = "./data/morpho-curators.json";
export const cannotUseApi = (chainId, fork) => {
    if (fork === "MORPHO_BLUE") {
        return (chainId === Chain.OP_MAINNET ||
            chainId === Chain.HEMI_NETWORK ||
            chainId === Chain.BERACHAIN ||
            chainId === Chain.SONEIUM ||
            chainId === Chain.SEI_NETWORK ||
            chainId === Chain.BNB_SMART_CHAIN_MAINNET ||
            chainId === Chain.CELO_MAINNET ||
            chainId === Chain.LISK ||
            chainId === Chain.TAC_MAINNET);
    }
    return true; // can't use api for moolah
};
function sortEntriesById(data) {
    // Create a new object to avoid mutating the original
    const sortedData = {};
    for (const chainId in data) {
        const protocols = data[chainId];
        sortedData[chainId] = {};
        for (const protocol in protocols) {
            const entries = protocols[protocol];
            // Sort by the 'id' field alphabetically
            const sortedEntries = [...entries].sort((a, b) => a.id.localeCompare(b.id));
            sortedData[chainId][protocol] = sortedEntries;
        }
    }
    return sortedData;
}
/**
 * Merges old and new data maps based on unique combinations of loanAsset and collateralAsset
 * @param {Object} oldDataMap - The old data map with chainId keys
 * @param {Object} newDataMap - The new data map with chainId keys
 * @returns {Object} Merged data map with new data taking precedence
 */
function mergeOracleDataMaps(oldDataMap, newDataMap) {
    let merged = {};
    // iterate over chains
    const allChainIds = new Set([
        ...Object.keys(oldDataMap || {}),
        ...Object.keys(newDataMap || {}),
    ]);
    for (const chainId of allChainIds) {
        // Get all unique forks from both maps
        const allForks = new Set([
            ...Object.keys(oldDataMap[chainId] || {}),
            ...Object.keys(newDataMap[chainId] || {}),
        ]);
        for (const fork of allForks) {
            const oldEntries = oldDataMap[chainId]?.[fork] || [];
            const newEntries = newDataMap[chainId]?.[fork] || [];
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
            if (!merged[chainId])
                merged[chainId] = {};
            if (!merged[chainId][fork])
                merged[chainId][fork] = [];
            // Convert back to array and sort for consistency
            merged[chainId][fork] = Array.from(entryMap.values()).sort((a, b) => {
                // Sort by loanAsset first, then by collateralAsset
                if (a.loanAsset !== b.loanAsset) {
                    return a.loanAsset.localeCompare(b.loanAsset);
                }
                return a.collateralAsset.localeCompare(b.collateralAsset);
            });
        }
    }
    return merged;
}
/**
 * Append-only merge for morpho-type-markets.json.
 * Unions market ID arrays per fork/chain — never removes existing IDs.
 */
function mergeMarketsAppendOnly(oldData, newData) {
    const merged = {};
    const allForks = new Set([
        ...Object.keys(oldData || {}),
        ...Object.keys(newData || {}),
    ]);
    for (const fork of allForks) {
        merged[fork] = {};
        const allChains = new Set([
            ...Object.keys(oldData?.[fork] || {}),
            ...Object.keys(newData?.[fork] || {}),
        ]);
        for (const chainId of allChains) {
            const oldIds = oldData?.[fork]?.[chainId] || [];
            const newIds = newData?.[fork]?.[chainId] || [];
            merged[fork][chainId] = Array.from(new Set([...oldIds, ...newIds])).sort();
        }
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
         chainId_in: [${chainId}]
      },
      orderBy: SupplyAssetsUsd,
      orderDirection: Desc
      ) {
        items {
          id
          uniqueKey
          lltv
          oracleAddress
          whitelisted
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
        const PAGE_SIZE = 500;
        const allItems = [];
        let skip = 0;
        while (true) {
            const response = await fetch(BASE_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: this.query(PAGE_SIZE, skip, chainId), variables: {} }),
            });
            if (!response.ok) {
                throw new Error(`Network error: ${response.status} - ${response.statusText}`);
            }
            const data = await response.json();
            const items = data.data?.markets?.items ?? [];
            allItems.push(...items);
            if (items.length < PAGE_SIZE)
                break;
            skip += PAGE_SIZE;
        }
        return { markets: { items: allItems } };
    }
    async fetchData() {
        const chainids = [
            "1",
            "10",
            "56",
            "130",
            "137",
            "143",
            "239",
            "999",
            "1135",
            "1329",
            "1868",
            "8453",
            "42161",
            "42220",
            "43111",
            "80094",
            "747474",
        ];
        const MORPHO_BLUE_POOL_DATA = await readJsonFile(poolsFile);
        const MORPHO_BLUE_MARKETS = await readJsonFile(marketsFile);
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
                try {
                    if (cannotUseApi(chainId, fork)) {
                        // Use subgraph as primary source when available (returns all markets)
                        if (fork === "MORPHO_BLUE" && hasSubgraph(chainId)) {
                            try {
                                marketData = await fetchMarketsFromSubgraph(chainId);
                            }
                            catch (error) {
                                console.warn(`Subgraph fetch failed for chain ${chainId}, falling back to on-chain:`, error);
                                marketData = await getMarketsOnChain(chainId, { [fork]: forkConfig }, MORPHO_BLUE_MARKETS);
                            }
                        }
                        else {
                            marketData = await getMarketsOnChain(chainId, { [fork]: forkConfig }, MORPHO_BLUE_MARKETS);
                        }
                    }
                    else {
                        marketData = await this.fetchMorphoMarkets(chainId);
                    }
                }
                catch (error) {
                    console.warn(`Failed to fetch ${fork} markets for chain ${chainId}:`, error);
                    continue;
                }
                const items = marketData.markets?.items || [];
                for (const el of items) {
                    const hash = el.uniqueKey;
                    const enumName = `${fork}_${hash.slice(2).toUpperCase()}`;
                    if (!oracles[chainId])
                        oracles[chainId] = {};
                    if (!oracles[chainId][fork])
                        oracles[chainId][fork] = [];
                    const oracle = el.oracleAddress;
                    const loanAsset = el.loanAsset.address.toLowerCase();
                    const collateralAsset = el.collateralAsset?.address.toLowerCase();
                    const loanAssetDecimals = el.loanAsset.decimals;
                    const collateralAssetDecimals = el.collateralAsset?.decimals;
                    const isZero = (addr) => !addr || addr === "0x0000000000000000000000000000000000000000";
                    if (el.whitelisted && !isZero(collateralAsset) && !isZero(loanAsset) && !isZero(oracle)) {
                        oracles[chainId][fork].push({
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
                    // Append well-defined market IDs to config only for chains
                    // that cannot use the Morpho API (on-chain / subgraph chains)
                    if (cannotUseApi(chainId, fork)) {
                        const hasValidAssets = !isZero(collateralAsset) &&
                            !isZero(loanAsset) &&
                            !isZero(oracle) &&
                            loanAssetDecimals != null &&
                            collateralAssetDecimals != null;
                        if (hasValidAssets) {
                            if (!MORPHO_BLUE_MARKETS[fork])
                                MORPHO_BLUE_MARKETS[fork] = {};
                            if (!MORPHO_BLUE_MARKETS[fork][chainId])
                                MORPHO_BLUE_MARKETS[fork][chainId] = [];
                            const existing = MORPHO_BLUE_MARKETS[fork][chainId];
                            if (!existing.includes(hash)) {
                                existing.push(hash);
                            }
                        }
                    }
                    const bps = numberToBps(el.lltv);
                    const protocolPrefix = fork === Lender.LISTA_DAO ? "Lista" : "Morpho";
                    const shortPrefix = fork === Lender.LISTA_DAO ? "LD" : "MB";
                    const longName = `${protocolPrefix} ${collSym}-${loanSym} ${bps}`;
                    const shortName = `${shortPrefix} ${collSym}-${loanSym} ${bps}`;
                    names[enumName] = longName;
                    shortNames[enumName] = shortName;
                    // curators
                    if (el.whitelisted && !!el.supplyingVaults && el.supplyingVaults.length > 0) {
                        if (!curators[chainId])
                            curators[chainId] = {};
                        const uniqueCuratorList = Array.from(new Map(el.supplyingVaults
                            .flatMap((vault) => vault?.state?.curators || [])
                            .map((curator) => [curator.id, curator])).values());
                        curators[chainId][enumName] = uniqueCuratorList;
                    }
                }
            }
        }
        // Sort market IDs per chain for stable output
        for (const fork of Object.keys(MORPHO_BLUE_MARKETS)) {
            for (const chainId of Object.keys(MORPHO_BLUE_MARKETS[fork])) {
                if (Array.isArray(MORPHO_BLUE_MARKETS[fork][chainId])) {
                    MORPHO_BLUE_MARKETS[fork][chainId].sort();
                }
            }
        }
        return {
            [labelsFile]: { names, shortNames },
            [oraclesFile]: oracles,
            [poolsFile]: MORPHO_BLUE_POOL_DATA,
            [marketsFile]: MORPHO_BLUE_MARKETS,
            [curatorsFile]: sortEntriesById(curators),
        };
    }
    mergeData(oldData, data, fileKey) {
        if (fileKey === labelsFile) {
            return mergeData(oldData, data, this.defaults[labelsFile]);
        }
        if (fileKey === oraclesFile) {
            return mergeOracleDataMaps(oldData, data);
        }
        if (fileKey === poolsFile) {
            return mergeData(oldData, data);
        }
        if (fileKey === marketsFile) {
            return mergeMarketsAppendOnly(oldData, data);
        }
        if (fileKey === curatorsFile) {
            return mergeData(oldData, data, this.defaults[curatorsFile]);
        }
        throw new Error("Bad File");
    }
    defaults = {
        [labelsFile]: { names: DEFAULTS, shortNames: DEFAULTS_SHORT },
        [oraclesFile]: {},
        [marketsFile]: {},
        [curatorsFile]: {},
    };
}
function normalizeIrmFromItem(el) {
    if (el?.irm == null)
        return null;
    if (typeof el.irm === "string" && el.irm.startsWith("0x"))
        return el.irm.toLowerCase();
    const a = el.irm?.address;
    if (typeof a === "string" && a.startsWith("0x"))
        return a.toLowerCase();
    return null;
}
/**
 * Fetches all isolated markets for a chain (all forks in morpho-pools) with loan/collateral/oracle/irm/lltv.
 * Used by fetchMorphoOracleData to key oracle metadata by canonical market id.
 */
export async function fetchMorphoMarketRowsForChain(chainId) {
    const MORPHO_BLUE_POOL_DATA = await readJsonFile(poolsFile);
    const MORPHO_BLUE_MARKETS = await readJsonFile(marketsFile);
    const forks = Object.keys(MORPHO_BLUE_POOL_DATA);
    const rows = [];
    for (const fork of forks) {
        const forkConfig = MORPHO_BLUE_POOL_DATA[fork];
        if (!forkConfig[chainId])
            continue;
        let marketData;
        try {
            if (cannotUseApi(chainId, fork)) {
                if (fork === "MORPHO_BLUE" && hasSubgraph(chainId)) {
                    try {
                        marketData = await fetchMarketsFromSubgraph(chainId);
                    }
                    catch (error) {
                        console.warn(`Subgraph fetch failed for chain ${chainId}, falling back to on-chain:`, error);
                        marketData = await getMarketsOnChain(chainId, { [fork]: forkConfig }, MORPHO_BLUE_MARKETS);
                    }
                }
                else {
                    marketData = await getMarketsOnChain(chainId, { [fork]: forkConfig }, MORPHO_BLUE_MARKETS);
                }
            }
            else {
                const updater = new MorphoBlueUpdater();
                marketData = await updater.fetchMorphoMarkets(chainId);
            }
        }
        catch (error) {
            console.warn(`fetchMorphoMarketRowsForChain [${chainId}] fork ${fork}:`, error);
            continue;
        }
        const items = marketData.markets?.items || [];
        for (const el of items) {
            const hash = el.uniqueKey;
            const oracle = el.oracleAddress;
            const loanAsset = el.loanAsset?.address?.toLowerCase();
            const collateralAsset = el.collateralAsset?.address?.toLowerCase();
            const lltvStr = el.lltv != null ? String(el.lltv) : "";
            const irm = normalizeIrmFromItem(el);
            const isZero = (addr) => !addr || addr === "0x0000000000000000000000000000000000000000";
            if (isZero(collateralAsset) || isZero(loanAsset) || isZero(oracle) || !hash)
                continue;
            if (irm && lltvStr) {
                try {
                    const computed = computeMorphoMarketId({
                        loanToken: loanAsset,
                        collateralToken: collateralAsset,
                        oracle: oracle.toLowerCase(),
                        irm,
                        lltv: lltvStr,
                    });
                    if (computed.toLowerCase() !== hash.toLowerCase()) {
                        console.warn(`[morpho] market id mismatch chain=${chainId} fork=${fork}: onchain ${hash} vs computed ${computed}`);
                    }
                }
                catch {
                    /* ignore */
                }
            }
            rows.push({
                fork,
                uniqueKey: hash,
                oracleAddress: oracle.toLowerCase(),
                loanAsset,
                collateralAsset,
                loanAssetDecimals: el.loanAsset?.decimals,
                collateralAssetDecimals: el.collateralAsset?.decimals,
                lltv: lltvStr,
                irm: irm ?? "",
            });
        }
    }
    return rows;
}
