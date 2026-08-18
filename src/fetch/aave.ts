import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { fetchAaveEModeCounts } from "./aave/fetchEModes.js";
import { fetchAaveTypePriceOracles } from "./aave/fetchOracles.js";
import { fetchAaveTypeTokenData } from "./aave/fetchReserves.js";

const tokensFile = "./data/aave-tokens.json";
const pools = "./config/aave-pools.json";
const oraclesFile = "./data/aave-oracles.json";
const aaveAddresses = "./data/aave-reserves.json";

// Example of another updater (you can add more like this)
export class AaveUpdater implements DataUpdater {
  name = "Aave";

  async fetchData(): Promise<Partial<any>> {
    const { reserves, tokens, AAVE_FORK_POOL_DATA } =
      await fetchAaveTypeTokenData();
    const oracles = await fetchAaveTypePriceOracles(AAVE_FORK_POOL_DATA);
    // The pool has no e-mode count getter, so consumers cannot know how many
    // categories to read. Probe it and publish it on the pool row; deployments
    // whose probe was not clean are simply absent and keep their old count.
    const eModeCounts = await fetchAaveEModeCounts(AAVE_FORK_POOL_DATA);
    return {
      [aaveAddresses]: reserves,
      [tokensFile]: tokens,
      [oraclesFile]: oracles,
      [pools]: mergeData(AAVE_FORK_POOL_DATA, eModeCounts),
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return mergeData(oldData, data);
  }

  defaults = {};
}
