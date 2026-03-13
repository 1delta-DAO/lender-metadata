// aproach for compound
// get number of reserves and base asset from comet
// fetch underlyings per index

import { COMET_ABIS, CompoundV3FetchFunctions } from "./abi.js";
import { multicallRetry, readJsonFile } from "../utils/index.js";
import { sleep } from "../../utils.js";

type CompoundV3Map = {
  [cometId: string]: {
    [chainid: string]: {
      baseAsset: string;
      baseBorrowMin: bigint;
      baseAsetSymbol: string;
      reserves: string[];
      nAssets: number;
    };
  };
};

type AddressChainMap = {
  [cometId: string]: {
    [chainid: string]: {
      [asset: string]: string;
    };
  };
};

// @ts-ignore
BigInt.prototype["toJSON"] = function () {
  return this.toString();
};

// store maps
export async function fetchCompoundV3Data(): Promise<{
  compoundBaseData: any;
  compoundReserves: any;
  cometOracles: AddressChainMap
  COMETS_PER_CHAIN_MAP: any;
}> {
  let cometDataMap: CompoundV3Map = {};
  let cometOracles: AddressChainMap = {};
  let compoundReserves: any = {};
  let compoundBaseData: any = {};
  const COMETS_PER_CHAIN_MAP = await readJsonFile(
    "./config/compound-v3-pools.json",
  );
  const chains = Object.keys(COMETS_PER_CHAIN_MAP);
  for (const chain of chains) {
    try {
      const comets = Object.values(COMETS_PER_CHAIN_MAP[chain]);

      const cometMetas = (await multicallRetry(
        {
          chainId: chain,
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
              {
                abi: COMET_ABIS,
                functionName: CompoundV3FetchFunctions.baseTokenPriceFeed,
                address: comet,
                args: [],
              },
            ])
            .flat() as any[],
        },
        12,
      )) as any;

      const cometKeys = Object.keys(COMETS_PER_CHAIN_MAP[chain]);
      for (let i = 0; i < comets.length; i++) {
        try {
          const comet = comets[i];
          const metaSlice = (cometMetas as any[]).slice(4 * i, 4 * i + 4);
          const [numAssetsResult, baseAssetResult, baseBorrowMin, baseTokenFeed] = metaSlice;

          if (numAssetsResult == null || !baseAssetResult) {
            console.error(`Compound V3: missing meta for comet ${cometKeys[i]} on chain ${chain}, skipping`);
            continue;
          }

          const nAssets = numAssetsResult;
          const baseAsset = baseAssetResult.toLowerCase();
          const cometIndexes = Array.from({ length: nAssets }, (_, j) => j);
          await sleep(500);
          const underlyingDatas = (await multicallRetry(
            {
              chainId: chain,
              allowFailure: false,
              contracts: cometIndexes.map((j) => ({
                abi: COMET_ABIS,
                functionName: CompoundV3FetchFunctions.getAssetInfo,
                address: comet,
                args: [j],
              })) as any[],
            },
            12,
          )) as any[];

          // Build underlyings and oracle map together using the original index j
          // to avoid misalignment after filtering failed results
          const underlyings: string[] = [];
          const pendingOracles: Record<string, string> = {};
          for (const j of cometIndexes) {
            const raw = underlyingDatas[j];
            const asset = raw?.asset?.toLowerCase();
            if (!asset) continue;
            underlyings.push(asset);
            pendingOracles[asset] = raw?.priceFeed;
          }

          if (underlyings.length < nAssets) {
            console.error(
              `Compound V3: incomplete asset data for comet ${cometKeys[i]} on chain ${chain} ` +
              `(got ${underlyings.length}/${nAssets}), skipping to avoid overwriting existing data`,
            );
            continue;
          }

          if (!cometDataMap[cometKeys[i]]) cometDataMap[cometKeys[i]] = {};
          if (!cometOracles[cometKeys[i]]) cometOracles[cometKeys[i]] = {};
          if (!compoundBaseData[cometKeys[i]]) compoundBaseData[cometKeys[i]] = {};
          if (!compoundReserves[cometKeys[i]]) compoundReserves[cometKeys[i]] = {};

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
        } catch (e) {
          console.error(`Compound V3: failed to fetch comet ${cometKeys[i]} on chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.error(`Compound V3: failed to fetch chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
    }
  }

  return { compoundReserves, compoundBaseData, COMETS_PER_CHAIN_MAP, cometOracles };
}
