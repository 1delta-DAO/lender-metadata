import { DataUpdater } from "../types.js";
import { fetchCompoundV2TypeTokenData } from "./compound-v2/fetchEverything.js";
import { fetchCompoundV2Irms } from "./compound-v2/fetchIrms.js";

const pools = "./config/compound-v2-pools.json";
const tokens = "./data/compound-v2-c-tokens.json";
const tokenArray = "./data/compound-v2-tokens.json";
const reservesPath = "./data/compound-v2-reserves.json";
const oraclesPath = "./data/compound-v2-oracles.json";
const irmsPath = "./data/compound-v2-irms.json";


// Example of another updater (you can add more like this)
export class CompoundV2Updater implements DataUpdater {
  name = "Compound V2";

  async fetchData(): Promise<Partial<any>> {
    const { cTokens, cTokenArray, reserves, COMPOUND_V2_COMPTROLLERS, oracles } =
      await fetchCompoundV2TypeTokenData();
    const irms = await fetchCompoundV2Irms(COMPOUND_V2_COMPTROLLERS, cTokenArray as any);
    // Placeholder for another data source
    // This could fetch from another API, parse files, etc.
    return {
      [tokenArray]: cTokenArray,
      [tokens]: cTokens,
      [reservesPath]: reserves,
      [oraclesPath]: oracles,
      [irmsPath]: irms,
      [pools]: COMPOUND_V2_COMPTROLLERS,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return data;
  }

  defaults = {};
}
