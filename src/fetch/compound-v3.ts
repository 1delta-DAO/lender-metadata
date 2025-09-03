import { DataUpdater } from "../types.js";
import { fetchCompoundV3Data } from "./compound-v3/fetchEverything.js";

const pools = "./config/compound-v3-pools.json";
const baseData = "./data/compound-v3-base-data.json";
const reserves = "./data/compound-v3-reserves.json";

// Example of another updater (you can add more like this)
export class CompoundV3Updater implements DataUpdater {
  name = "Compound V3";

  async fetchData(): Promise<Partial<any>> {
    const { compoundReserves, compoundBaseData, COMETS_PER_CHAIN_MAP } =
      await fetchCompoundV3Data();

    // Placeholder for another data source
    // This could fetch from another API, parse files, etc.
    return {
      [baseData]: compoundBaseData,
      [reserves]: compoundReserves,
      [pools]: COMETS_PER_CHAIN_MAP,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return data;
  }

  defaults = {};
}
