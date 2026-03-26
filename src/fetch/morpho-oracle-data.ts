import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { fetchMorphoOracleData } from "./morpho/fetchMorphoOracleData.js";

const oraclesDataFile = "./data/morpho-oracles-data.json";

export class MorphoOracleDataUpdater implements DataUpdater {
  name = "Morpho Oracle Data";

  async fetchData(): Promise<Partial<any>> {
    const data = await fetchMorphoOracleData();
    return { [oraclesDataFile]: data };
  }

  mergeData(oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(oldData, data);
  }

  defaults = {};
}
