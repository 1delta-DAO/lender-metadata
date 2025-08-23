import { DataUpdater } from "../types.js";
import { fetchAaveTypePriceOracles } from "./aave/fetchOracles.js";
import { fetchAaveTypeTokenData } from "./aave/fetchReserves.js";

const tokensFile = "./data/aave-tokens.json";
const oraclesFile = "./data/aave-oracles.json";
const aaveAddresses = "./data/aave-addresses.json";

// Example of another updater (you can add more like this)
export class AaveUpdater implements DataUpdater {
  name = "Aave";

  async fetchData(): Promise<Partial<any>> {
    const reserves = await fetchAaveTypeTokenData();
    const oracles = await fetchAaveTypePriceOracles();
    // Placeholder for another data source
    // This could fetch from another API, parse files, etc.
    return {
      [aaveAddresses]: reserves,
      [tokensFile]: {},
      [oraclesFile]: oracles,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return data;
  }

  defaults = {};
}
