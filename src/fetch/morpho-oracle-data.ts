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

  /**
   * Do not deep-merge with old files (would keep legacy oracle-address keys or removed chains).
   */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
