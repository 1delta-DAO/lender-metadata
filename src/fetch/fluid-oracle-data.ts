import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyFluidOracles } from "./fluid/classifyOracles.js";

const fluidClassifiedFile = "./data/fluid-oracles-classified.json";

export class FluidOracleDataUpdater implements DataUpdater {
  name = "Fluid Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyFluidOracles();
    return { [fluidClassifiedFile]: data };
  }

  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
