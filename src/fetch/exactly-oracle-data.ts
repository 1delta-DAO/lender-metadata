import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyExactlyOracles } from "./exactly/classifyOracles.js";

const oraclesClassifiedFile = "./data/exactly-oracles-classified.json";

export class ExactlyOracleDataUpdater implements DataUpdater {
  name = "Exactly Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyExactlyOracles();
    return { [oraclesClassifiedFile]: data };
  }

  /** Replace wholesale — keeping stale chain/market keys would be misleading. */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
