import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifySiloOracles } from "./silo/classifyOracles.js";

const siloClassifiedFile = "./data/silo-oracles-classified.json";

export class SiloOracleDataUpdater implements DataUpdater {
  name = "Silo Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifySiloOracles();
    return { [siloClassifiedFile]: data };
  }

  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
