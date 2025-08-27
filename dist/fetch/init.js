import { INIT_CONFIG_PER_CHAIN_MAP } from "@1delta/asset-registry";
import { fetchInitData } from "./init/fetchEverything.js";
const config = "./data/init-config.json";
const pools = "./data/init-pools.json";
// Example of another updater (you can add more like this)
export class InitUpdater {
    name = "Init";
    async fetchData() {
        const { initDataMap } = await fetchInitData();
        // Placeholder for another data source
        // This could fetch from another API, parse files, etc.
        return {
            [config]: initDataMap,
            [pools]: INIT_CONFIG_PER_CHAIN_MAP,
        };
    }
    mergeData(oldData, data, fileKey) {
        return data;
    }
    defaults = {};
}
