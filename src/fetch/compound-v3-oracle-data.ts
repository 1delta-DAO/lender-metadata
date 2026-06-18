import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyCompoundV3Oracles } from "./compound-v3/classifyOracles.js";

const oraclesClassifiedFile = "./data/compound-v3-oracles-classified.json";

export class CompoundV3OracleDataUpdater implements DataUpdater {
  name = "Compound V3 Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyCompoundV3Oracles();
    return { [oraclesClassifiedFile]: data };
  }

  /** Replace wholesale — keeping stale comet/chain/asset keys would be misleading. */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
