import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyDolomiteOracles } from "./dolomite/classifyOracles.js";

const oraclesClassifiedFile = "./data/dolomite-oracles-classified.json";

export class DolomiteOracleDataUpdater implements DataUpdater {
  name = "Dolomite Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyDolomiteOracles();
    return { [oraclesClassifiedFile]: data };
  }

  /** Replace wholesale — keeping stale chain/marketId keys would be misleading. */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
