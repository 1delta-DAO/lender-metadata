import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyLiquityOracles } from "./liquity/classifyOracles.js";

const oraclesClassifiedFile = "./data/liquity-oracles-classified.json";

export class LiquityOracleDataUpdater implements DataUpdater {
  name = "Liquity Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyLiquityOracles();
    return { [oraclesClassifiedFile]: data };
  }

  /** Replace wholesale — keeping stale chain/branch keys would be misleading. */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
