// ============================================================================
// Data Updaters
// ============================================================================
import { DEFAULTS, DEFAULTS_SHORT } from "../defaults.js";
import { numberToBps } from "../utils.js";
export class MorphoBlueUpdater {
    name = "Morpho Blue Markets";
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
        const chainids = ["1", "137", "8453", "42161", "747474"];
        const mbData = await Promise.all(chainids.map((id) => this.fetchMorphoMarkets(id)));
        const items = mbData
            .map((data, i) => data.markets.items.map((a) => ({ ...a, chainId: chainids[i] })))
            .flatMap((b) => b);
        const names = {};
        const shortNames = {};
        const oracles = {};
        for (const el of items) {
            const hash = el.uniqueKey;
            const enumName = `MORPHO_BLUE_${hash.slice(2).toUpperCase()}`;
            const chainId = el.chainId;
            if (!oracles[chainId])
                oracles[chainId] = [];
            const oracle = el.oracleAddress;
            const loanAsset = el.loanAsset.address.toLowerCase();
            const collateralAsset = el.collateralAsset?.address.toLowerCase();
            const loanAssetDecimals = el.loanAsset.decimals;
            const collateralAssetDecimals = el.collateralAsset?.decimals;
            if (collateralAsset &&
                loanAsset &&
                oracle !== "0x0000000000000000000000000000000000000000") {
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
            const longName = `Morpho ${collSym}-${loanSym} ${bps}`;
            const shortName = `MB ${collSym}-${loanSym} ${bps}`;
            names[enumName] = longName;
            shortNames[enumName] = shortName;
        }
        return { names, shortNames, oracles };
    }
    defaults = { names: DEFAULTS, shortNames: DEFAULTS_SHORT, oracles: {} };
}
