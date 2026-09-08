// ============================================================================
// Data Updaters
// ============================================================================

import { DEFAULTS, DEFAULTS_SHORT } from "../defaults.js";
import { DataUpdater } from "../../types.js";
import { mergeData, numberToBps } from "../../utils.js";
import { readJsonFile } from "../utils/index.js";
import { Chain } from "@1delta/chain-registry";
import { getMarketsOnChain } from "./fetchMorphoOnChain.js";
import {
  hasSubgraph,
  fetchMarketsFromSubgraph,
} from "./fetchMorphoSubgraph.js";
import {
  hasMysticApi,
  mysticApiUsable,
  fetchMarketsFromMysticApi,
} from "./fetchMysticApi.js";
import { Lender } from "@1delta/lender-registry";
import { computeMorphoMarketId } from "./morphoMarketId.js";

const labelsFile = "./data/lender-labels.json";
const oraclesFile = "./data/morpho-type-oracles.json";
const poolsFile = "./config/morpho-pools.json";
const marketsFile = "./config/morpho-type-markets.json";
const curatorsFile = "./data/morpho-curators.json";

// Chains the main MorphoBlueUpdater walks. A chain is treated as having Morpho
// API coverage iff it is in this list AND `cannotUseApi` returns false for it.
export const MORPHO_MAIN_CHAIN_IDS = [
  "1",
  "10",
  "14",
  "56",
  "130",
  "137",
  "143",
  "239",
  "480",
  "988",
  "999",
  "1135",
  "1329",
  "1868",
  "4114",
  "4217",
  "4326",
  "4663",
  "5042",
  "8453",
  "42161",
  "42220",
  "43111",
  "80094",
  "747474",
  "98866",
];

export const cannotUseApi = (chainId: string, fork: string) => {
  if (fork === "MORPHO_BLUE") {
    return (
      chainId === Chain.HEMI_NETWORK ||
      chainId === Chain.BERACHAIN ||
      chainId === Chain.SONEIUM ||
      chainId === Chain.SEI_NETWORK ||
      chainId === Chain.BNB_SMART_CHAIN_MAINNET ||
      chainId === Chain.CELO_MAINNET ||
      chainId === Chain.LISK ||
      chainId === Chain.TAC_MAINNET ||
      chainId === Chain.MEGAETH_MAINNET ||
      hasMysticApi(chainId)
    );
  }
  return true; // can't use api for moolah
};

type Entry = {
  id: string;
  image: string;
  verified: boolean;
  name: string;
};

type DataStructure = {
  [chainId: string]: {
    [protocol: string]: Entry[];
  };
};

function sortEntriesById(data: DataStructure): DataStructure {
  // Create a new object to avoid mutating the original
  const sortedData: DataStructure = {};

  for (const chainId in data) {
    const protocols = data[chainId];
    sortedData[chainId] = {};

    for (const protocol in protocols) {
      const entries = protocols[protocol];
      // Sort by the 'id' field alphabetically
      const sortedEntries = [...entries].sort((a, b) =>
        String(a?.id ?? "").localeCompare(String(b?.id ?? ""))
      );
      sortedData[chainId][protocol] = sortedEntries;
    }
  }

  return sortedData;
}

/**
 * Merge old and new oracle-roster maps, keyed by the (oracle, loanAsset,
 * collateralAsset) TRIPLET.
 *
 * The oracle belongs in the key. Morpho lets anyone open a market on any
 * oracle, so one loan/collateral pair routinely has several — and every
 * consumer identifies a row by the triplet, not the pair: margin-fetcher's
 * `generateMarketId(oracle, loanAsset, collateralAsset)` builds the
 * `MORPHO_BLUE_<id>` key from all three, and `collectMarketInputs` dedupes on
 * `marketTripletKey(loan, coll, oracle)`.
 *
 * Keyed on the pair alone (as this did until 2026-09-07) the merge silently
 * kept only the LAST row for each pair, on every run, in both directions —
 * old entries displaced by new ones and vice versa. The damage was invisible
 * because the file always looked self-consistent: afterwards no pair has two
 * oracles, which reads as "there is only one" rather than "the rest were
 * dropped". Measured against `morpho-oracles-data.json` (keyed by market id,
 * so unaffected), Ethereum alone had 34 pairs served by multiple oracles —
 * 37 rows this merge was discarding every time it ran.
 *
 * @param {Object} oldDataMap - The old data map with chainId keys
 * @param {Object} newDataMap - The new data map with chainId keys
 * @returns {Object} Merged data map with new data taking precedence
 */
export function mergeOracleDataMaps(oldDataMap: any, newDataMap: any) {
  let merged: any = {};

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

      // Quick-lookup key: the full triplet, lower-cased so a checksum-cased
      // row from one source never reads as distinct from the same row in
      // another.
      const keyOf = (entry: any) =>
        [entry.oracle, entry.loanAsset, entry.collateralAsset]
          .map((v: unknown) => String(v ?? "").toLowerCase())
          .join("-");
      const entryMap = new Map();

      // Add old entries first
      for (const entry of oldEntries) {
        entryMap.set(keyOf(entry), entry);
      }

      // Add new entries (will overwrite old ones with same key)
      for (const entry of newEntries) {
        entryMap.set(keyOf(entry), entry);
      }

      if (!merged[chainId]) merged[chainId] = {};
      if (!merged[chainId][fork]) merged[chainId][fork] = [];
      // Convert back to array and sort for consistency
      merged[chainId][fork] = Array.from(entryMap.values()).sort((a, b) => {
        // Sort by loanAsset, then collateralAsset, then oracle — the oracle
        // tiebreak keeps the file order stable now that a pair can hold more
        // than one row.
        if (a.loanAsset !== b.loanAsset) {
          return a.loanAsset.localeCompare(b.loanAsset);
        }
        if (a.collateralAsset !== b.collateralAsset) {
          return a.collateralAsset.localeCompare(b.collateralAsset);
        }
        return String(a.oracle ?? "").localeCompare(String(b.oracle ?? ""));
      });
    }
  }

  return merged;
}

/**
 * Append-only merge for morpho-type-markets.json.
 * Unions market ID arrays per fork/chain — never removes existing IDs.
 */
function mergeMarketsAppendOnly(oldData: any, newData: any) {
  const merged: any = {};
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
      const oldIds: string[] = oldData?.[fork]?.[chainId] || [];
      const newIds: string[] = newData?.[fork]?.[chainId] || [];
      merged[fork][chainId] = Array.from(new Set([...oldIds, ...newIds])).sort();
    }
  }

  return merged;
}

export class MorphoBlueUpdater implements DataUpdater {
  name = "Morpho Blue Markets";

  // to-do: add this to supplyingVaults.state and check the market.id and calculate correctly
  // allocation {
  //   supplyAssets
  //   supplyAssetsUsd
  //   market {
  //     id
  //   }
  // }
  // NB: order by `UniqueKey`, NOT a numeric metric. The blue-api excludes
  // markets with a null metric from the result set when you order by it, so
  // `orderBy: SupplyAssetsUsd` silently drops every zero-supply (idle)
  // market — ~700 on Base alone — and they never get a label. `UniqueKey` is
  // present on every market, so pagination stays stable and complete.
  private query(first: number, skip: number, chainId: string): string {
    return `
    query GetMarkets {
      markets(first: ${first}, skip: ${skip}, where:  {
         chainId_in: [${chainId}]
      },
      orderBy: UniqueKey,
      orderDirection: Asc
      ) {
        items {
          marketId
          lltv
          oracleAddress
          irmAddress
          listed
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

  private async fetchMorphoMarkets(chainId: string): Promise<any> {
    const BASE_URL = "https://blue-api.morpho.org/graphql";
    const PAGE_SIZE = 500;
    const allItems: any[] = [];
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

      const data: any = await response.json();
      const items: any[] = data.data?.markets?.items ?? [];
      allItems.push(...items);

      if (items.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    }

    return { markets: { items: allItems } };
  }

  async fetchData(): Promise<any> {
    const chainids = MORPHO_MAIN_CHAIN_IDS;
    const MORPHO_BLUE_POOL_DATA = await readJsonFile(poolsFile);
    const MORPHO_BLUE_MARKETS = await readJsonFile(marketsFile);
    const forks = Object.keys(MORPHO_BLUE_POOL_DATA);

    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};
    const oracles: Record<string, Record<string, any[]>> = {};
    const curators: Record<string, Record<string, any[]>> = {};

    for (const fork of forks) {
      const forkConfig = MORPHO_BLUE_POOL_DATA[fork];

      for (const chainId of chainids) {
        if (!forkConfig[chainId]) continue;
        let marketData: any;

        try {
          if (cannotUseApi(chainId, fork)) {
            // Mystic Finance hosts a Morpho Blue fork on a few chains and
            // exposes its own indexer; prefer it over on-chain reads WHEN WE
            // CAN READ IT. Unkeyed it 401s, so gating on `hasMysticApi` alone
            // spent a request per chain per run to log a fallback warning.
            if (fork === "MORPHO_BLUE" && mysticApiUsable(chainId)) {
              try {
                marketData = await fetchMarketsFromMysticApi(chainId);
              } catch (error) {
                console.warn(
                  `Mystic API fetch failed for chain ${chainId}, falling back to on-chain:`,
                  error
                );
                marketData = await getMarketsOnChain(
                  chainId,
                  { [fork]: forkConfig },
                  MORPHO_BLUE_MARKETS
                );
              }
            } else if (fork === "MORPHO_BLUE" && hasSubgraph(chainId)) {
              // Use subgraph as primary source when available (returns all markets)
              try {
                marketData = await fetchMarketsFromSubgraph(chainId);
              } catch (error) {
                console.warn(
                  `Subgraph fetch failed for chain ${chainId}, falling back to on-chain:`,
                  error
                );
                marketData = await getMarketsOnChain(
                  chainId,
                  { [fork]: forkConfig },
                  MORPHO_BLUE_MARKETS
                );
              }
            } else {
              marketData = await getMarketsOnChain(
                chainId,
                { [fork]: forkConfig },
                MORPHO_BLUE_MARKETS
              );
            }
          } else {
            marketData = await this.fetchMorphoMarkets(chainId);
          }
        } catch (error) {
          console.warn(
            `Failed to fetch ${fork} markets for chain ${chainId}:`,
            error
          );
          continue;
        }

        const items = marketData.markets?.items || [];

        for (const el of items) {
          const hash: string = el.marketId ?? el.uniqueKey;
          const enumName = `${fork}_${hash.slice(2).toUpperCase()}`;

          // ONE predicate for every write below.
          //
          // It used to be spelled out separately at each of the three call
          // sites, and the label write simply did not carry it — so the roster
          // described markets it could not price. Measured 2026-09-08: 7,506
          // MORPHO_BLUE markets had a label in `lender-labels.json` while only
          // 1,199 had a row in `morpho-oracles-data.json`, and on Robinhood
          // Chain all 56 Longbow markets were named with 0 priced. A name is
          // what makes a market look present; the oracle row is what makes it
          // usable. They have to be gated together or the gap is invisible.
          //
          // NOTE the merge for `lender-labels.json` is additive (`mergeData` ->
          // `deepMerge`), so this is FORWARD-only: labels already written for
          // unlisted markets survive until something prunes them deliberately.
          // That is the safe direction — see the null-clobber and pair-keyed
          // merge losses this file has already caused.
          const isListed: boolean = (el.listed ?? el.whitelisted) === true;

          if (!oracles[chainId]) oracles[chainId] = {};
          if (!oracles[chainId][fork]) oracles[chainId][fork] = [];

          const oracle = el.oracleAddress;
          const loanAsset = el.loanAsset.address.toLowerCase();
          const collateralAsset = el.collateralAsset?.address.toLowerCase();
          const loanAssetDecimals = el.loanAsset.decimals;
          const collateralAssetDecimals = el.collateralAsset?.decimals;

          const isZero = (addr: string | undefined) =>
            !addr || addr === "0x0000000000000000000000000000000000000000";

          if (isListed && !isZero(collateralAsset) && !isZero(loanAsset) && !isZero(oracle)) {
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
          if (!loanSym || !collSym) continue;

          // Append well-defined market IDs to config only for chains
          // that cannot use the Morpho API (on-chain / subgraph chains)
          if (cannotUseApi(chainId, fork)) {
            const hasValidAssets =
              !isZero(collateralAsset) &&
              !isZero(loanAsset) &&
              !isZero(oracle) &&
              loanAssetDecimals != null &&
              collateralAssetDecimals != null;

            if (hasValidAssets) {
              if (!MORPHO_BLUE_MARKETS[fork]) MORPHO_BLUE_MARKETS[fork] = {};
              if (!MORPHO_BLUE_MARKETS[fork][chainId])
                MORPHO_BLUE_MARKETS[fork][chainId] = [];
              const existing: string[] = MORPHO_BLUE_MARKETS[fork][chainId];
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

          // Same gate as the oracle roster above: do not NAME a market whose
          // oracle we deliberately skipped. Deliberately placed AFTER the
          // `MORPHO_BLUE_MARKETS` append, which is market DISCOVERY for the
          // chains that cannot use the API and must keep running regardless of
          // curation (`fetchMorphoOnChain` / `fetchMysticApi` hardcode the flag
          // true for exactly that reason).
          if (isListed) {
            names[enumName] = longName;
            shortNames[enumName] = shortName;
          }

          // curators
          if (isListed && !!el.supplyingVaults && el.supplyingVaults.length > 0) {
            if (!curators[chainId]) curators[chainId] = {};
            const uniqueCuratorList = Array.from(
              new Map(
                el.supplyingVaults
                  .flatMap((vault: any) => vault?.state?.curators || [])
                  .map((curator: any) => [curator.id, curator])
              ).values()
            );
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

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
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

/** One Morpho / Lista isolated market with params needed for market id + DB joins. */
export type MorphoMarketRow = {
  fork: string;
  /** Canonical bytes32 market id (0x-prefixed), from API/subgraph/on-chain. */
  uniqueKey: string;
  oracleAddress: string;
  loanAsset: string;
  collateralAsset: string;
  loanAssetDecimals?: number;
  collateralAssetDecimals?: number;
  lltv: string;
  irm: string;
};

function normalizeIrmFromItem(el: any): string | null {
  // Morpho blue-api exposes the IRM as `irmAddress`; on-chain/subgraph paths use `irm`.
  if (typeof el?.irmAddress === "string" && el.irmAddress.startsWith("0x"))
    return el.irmAddress.toLowerCase();
  if (el?.irm == null) return null;
  if (typeof el.irm === "string" && el.irm.startsWith("0x")) return el.irm.toLowerCase();
  const a = el.irm?.address;
  if (typeof a === "string" && a.startsWith("0x")) return a.toLowerCase();
  return null;
}

/**
 * Fetches all isolated markets for a chain (all forks in morpho-pools) with loan/collateral/oracle/irm/lltv.
 * Used by fetchMorphoOracleData to key oracle metadata by canonical market id.
 */
export async function fetchMorphoMarketRowsForChain(
  chainId: string
): Promise<MorphoMarketRow[]> {
  const MORPHO_BLUE_POOL_DATA = await readJsonFile(poolsFile);
  const MORPHO_BLUE_MARKETS = await readJsonFile(marketsFile);
  const forks = Object.keys(MORPHO_BLUE_POOL_DATA);
  const rows: MorphoMarketRow[] = [];

  for (const fork of forks) {
    const forkConfig = MORPHO_BLUE_POOL_DATA[fork];
    if (!forkConfig[chainId]) continue;

    let marketData: any;
    try {
      if (cannotUseApi(chainId, fork)) {
        // Same key gate as the batch path above: unkeyed, this branch can
        // only 401, so the on-chain read is the real source here.
        if (fork === "MORPHO_BLUE" && mysticApiUsable(chainId)) {
          try {
            marketData = await fetchMarketsFromMysticApi(chainId);
          } catch (error) {
            console.warn(
              `Mystic API fetch failed for chain ${chainId}, falling back to on-chain:`,
              error
            );
            marketData = await getMarketsOnChain(
              chainId,
              { [fork]: forkConfig },
              MORPHO_BLUE_MARKETS
            );
          }
        } else if (fork === "MORPHO_BLUE" && hasSubgraph(chainId)) {
          try {
            marketData = await fetchMarketsFromSubgraph(chainId);
          } catch (error) {
            console.warn(
              `Subgraph fetch failed for chain ${chainId}, falling back to on-chain:`,
              error
            );
            marketData = await getMarketsOnChain(
              chainId,
              { [fork]: forkConfig },
              MORPHO_BLUE_MARKETS
            );
          }
        } else {
          marketData = await getMarketsOnChain(
            chainId,
            { [fork]: forkConfig },
            MORPHO_BLUE_MARKETS
          );
        }
      } else {
        // API-capable chain: try the Morpho blue-api, but fall back to subgraph /
        // on-chain on failure so a schema change (e.g. a 400 from a renamed field)
        // doesn't silently drop the entire chain's markets.
        try {
          const updater = new MorphoBlueUpdater();
          marketData = await (updater as any).fetchMorphoMarkets(chainId);
        } catch (apiError) {
          console.warn(
            `Morpho API fetch failed for chain ${chainId}, falling back to on-chain:`,
            apiError instanceof Error ? apiError.message : apiError
          );
          if (fork === "MORPHO_BLUE" && hasSubgraph(chainId)) {
            try {
              marketData = await fetchMarketsFromSubgraph(chainId);
            } catch {
              marketData = await getMarketsOnChain(
                chainId,
                { [fork]: forkConfig },
                MORPHO_BLUE_MARKETS
              );
            }
          } else {
            marketData = await getMarketsOnChain(
              chainId,
              { [fork]: forkConfig },
              MORPHO_BLUE_MARKETS
            );
          }
        }
      }
    } catch (error) {
      console.warn(`fetchMorphoMarketRowsForChain [${chainId}] fork ${fork}:`, error);
      continue;
    }

    const items = marketData.markets?.items || [];
    for (const el of items) {
      const hash: string = el.marketId ?? el.uniqueKey;
      const oracle = el.oracleAddress;
      const loanAsset = el.loanAsset?.address?.toLowerCase();
      const collateralAsset = el.collateralAsset?.address?.toLowerCase();
      const lltvStr = el.lltv != null ? String(el.lltv) : "";
      const irm = normalizeIrmFromItem(el);

      const isZero = (addr: string | undefined) =>
        !addr || addr === "0x0000000000000000000000000000000000000000";

      if (isZero(collateralAsset) || isZero(loanAsset) || isZero(oracle) || !hash) continue;

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
            console.warn(
              `[morpho] market id mismatch chain=${chainId} fork=${fork}: onchain ${hash} vs computed ${computed}`
            );
          }
        } catch {
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
