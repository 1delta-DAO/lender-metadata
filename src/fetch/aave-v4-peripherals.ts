import { DataUpdater } from "../types.js";
import {
  fetchAaveV4Peripherals,
  mergeAaveV4PeripheralsData,
} from "./aave/fetchV4Peripherals.js";
import { AAVE_V4_HUB_SEED } from "./aave/v4Hubs.js";

const outFile = "./config/aave-v4-peripherals.json";

export class AaveV4PeripheralsUpdater implements DataUpdater {
  name = "Aave V4 Peripherals";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    // Seed comes from `AAVE_V4_HUB_SEED`, not from `config/aave-v4-hubs.json`
    // — that file was deleted when the seed moved into code, and loading it
    // handed this pass an empty seed on every run.
    const data = await fetchAaveV4Peripherals(AAVE_V4_HUB_SEED);
    return { [outFile]: data };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    if (fileKey === outFile) {
      return mergeAaveV4PeripheralsData(oldData ?? {}, data ?? {});
    }
    return data;
  }

  defaults = {};
}
