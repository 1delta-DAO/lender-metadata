import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import {
  classifyAaveOracles,
  classifyAaveV4Oracles,
} from "./aave/classifyOracles.js";

const aaveClassifiedFile = "./data/aave-oracles-classified.json";
const aaveV4ClassifiedFile = "./data/aave-v4-oracles-classified.json";

export class AaveOracleDataUpdater implements DataUpdater {
  name = "Aave Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyAaveOracles();
    return { [aaveClassifiedFile]: data };
  }

  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}

export class AaveV4OracleDataUpdater implements DataUpdater {
  name = "Aave V4 Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyAaveV4Oracles();
    return { [aaveV4ClassifiedFile]: data };
  }

  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
