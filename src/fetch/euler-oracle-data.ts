import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyEulerOracles } from "./euler/classifyOracles.js";

const eulerClassifiedFile = "./data/euler-oracles-classified.json";

export class EulerOracleDataUpdater implements DataUpdater {
  name = "Euler Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyEulerOracles();
    return { [eulerClassifiedFile]: data };
  }

  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
