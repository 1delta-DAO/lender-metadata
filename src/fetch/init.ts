import { INIT_CONFIG_PER_CHAIN_MAP } from "@1delta/asset-registry";
import { DataUpdater } from "../types.js";
import { fetchInitData } from "./init/fetchEverything.js";

const config = "./data/init-config.json";
const pools = "./config/init-pools.json";

// Example of another updater (you can add more like this)
export class InitUpdater implements DataUpdater {
  name = "Init";

  async fetchData(): Promise<Partial<any>> {
    const { initDataMap } = await fetchInitData();
    // Placeholder for another data source
    // This could fetch from another API, parse files, etc.
    return {
      [config]: initDataMap,
      [pools]: INIT_CONFIG_PER_CHAIN_MAP,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return data;
  }

  defaults = {};
}
