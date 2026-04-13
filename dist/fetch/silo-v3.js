import { loadExisting, mergeData } from "../utils.js";
import { DEFAULTS, DEFAULTS_SHORT } from "./defaults.js";
import { fetchAllSilos } from "./silo-shared/graphql.js";
import { fetchSiloV3Peripherals } from "./silo-v3/peripherals.js";
import { buildAllSiloLabels } from "./silo-labels.js";
import { buildV3MarketsFromRaw } from "./silo-v3/api.js";
const peripheralsFile = "./config/silo-v3-peripherals.json";
const marketsFile = "./data/silo-v3-markets.json";
const labelsFile = "./data/lender-labels.json";
/**
 * Silo v3 lender metadata.
 *
 * Unlike v2, pair discovery + all static per-market fields come from a
 * single GraphQL call against `https://api-v3.silo.finance`. That API
 * exposes every field the v2 on-chain `SiloConfig.getConfig` pass
 * produces, so there is no multicall stage here.
 *
 * Peripherals (factory, lens, router, leverage router, vault factory, …)
 * are pulled from the official `silo-finance/silo-contracts-v3` repo
 * deployments dirs; see `./silo-v3/peripherals.ts`.
 */
export class SiloV3Updater {
    name = "Silo V3";
    async fetchData() {
        const [raw, peripherals] = await Promise.all([
            fetchAllSilos(),
            fetchSiloV3Peripherals(),
        ]);
        const markets = buildV3MarketsFromRaw(raw);
        const chainCounts = Object.entries(markets).map(([c, list]) => `${c}:${list.length}`);
        console.log(`Silo V3: fetched ${chainCounts.length} chains from API (${chainCounts.join(", ")})`);
        console.log(`Silo V3: fetched peripherals for ${Object.keys(peripherals).length} chains`);
        // Load existing on-disk markets for both versions so labels cover
        // chains the API no longer returns (e.g. sonic v2 not whitelisted in
        // the v3 indexer).
        let existingV2 = {};
        let existingV3 = {};
        try {
            existingV2 = await loadExisting("./data/silo-v2-markets.json");
        }
        catch { }
        try {
            existingV3 = await loadExisting(marketsFile);
        }
        catch { }
        const mergedV3 = { ...existingV3, ...markets };
        const labels = buildAllSiloLabels(raw, [
            { version: "V2", markets: existingV2 },
            { version: "V3", markets: mergedV3 },
        ]);
        return {
            [peripheralsFile]: peripherals,
            [marketsFile]: markets,
            [labelsFile]: labels,
        };
    }
    mergeData(oldData, data, fileKey) {
        if (fileKey === marketsFile) {
            // Fully regenerated per chain each run — overwrite one chain at a
            // time so a partial fetch doesn't wipe unrelated chains.
            const merged = { ...(oldData ?? {}) };
            for (const chain of Object.keys(data ?? {})) {
                merged[chain] = data[chain];
            }
            return merged;
        }
        if (fileKey === peripheralsFile) {
            // Peripherals are one entry per chain — merge per chain so a failed
            // fetch for one chain doesn't drop others. Within a chain, later
            // values win (deployments repo is authoritative).
            const merged = { ...(oldData ?? {}) };
            for (const chain of Object.keys(data ?? {})) {
                merged[chain] = {
                    ...(merged[chain] ?? {}),
                    ...data[chain],
                };
            }
            return merged;
        }
        if (fileKey === labelsFile) {
            return mergeData(oldData, data, this.defaults[labelsFile]);
        }
        return mergeData(oldData, data);
    }
    defaults = {
        [labelsFile]: { names: DEFAULTS, shortNames: DEFAULTS_SHORT },
    };
}
