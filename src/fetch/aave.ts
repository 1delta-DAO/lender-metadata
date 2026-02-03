import { DataUpdater } from "../types.js";
import { fetchAaveTypePriceOracles } from "./aave/fetchOracles.js";
import { fetchAaveTypeIrms } from "./aave/fetchIrms.js";
import { fetchAaveTypeTokenData } from "./aave/fetchReserves.js";

const tokensFile = "./data/aave-tokens.json";
const pools = "./config/aave-pools.json";
const oraclesFile = "./data/aave-oracles.json";
const aaveAddresses = "./data/aave-reserves.json";
const irmsFile = "./data/aave-irms.json";

// Example of another updater (you can add more like this)
export class AaveUpdater implements DataUpdater {
  name = "Aave";

  async fetchData(): Promise<Partial<any>> {
    const { reserves, tokens, AAVE_FORK_POOL_DATA } =
      await fetchAaveTypeTokenData();
    const oracles = await fetchAaveTypePriceOracles(AAVE_FORK_POOL_DATA);
    const irms = await fetchAaveTypeIrms(AAVE_FORK_POOL_DATA, reserves as any);
    // Placeholder for another data source
    // This could fetch from another API, parse files, etc.
    return {
      [aaveAddresses]: reserves,
      [tokensFile]: tokens,
      [oraclesFile]: oracles,
      [irmsFile]: irms,
      [pools]: AAVE_FORK_POOL_DATA,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return data;
  }

  defaults = {};
}
