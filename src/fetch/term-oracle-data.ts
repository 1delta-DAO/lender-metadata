import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyTermOracles } from "./term/classifyOracles.js";

const oraclesClassifiedFile = "./data/term-finance-oracles-classified.json";

export class TermOracleDataUpdater implements DataUpdater {
  name = "Term Finance Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyTermOracles();
    return { [oraclesClassifiedFile]: data };
  }

  /** Replace wholesale — keeping stale chain/token keys would be misleading. */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
