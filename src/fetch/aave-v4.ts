import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { loadExisting } from "../utils.js";
import { fetchAaveV4Configs } from "./aave/fetchV4Configs.js";
import { fetchAaveV4Reserves } from "./aave/fetchV4Reserves.js";
import { fetchAaveV4Oracles } from "./aave/fetchV4Oracles.js";

const hubsFile = "./config/aave-v4-hubs.json";
const spokesFile = "./data/aave-v4-spokes.json";
const reservesFile = "./data/aave-v4-reserves.json";
const reserveDetailsFile = "./data/aave-v4-reserve-details.json";
const oraclesFile = "./data/aave-v4-oracles.json";
const oracleSourcesFile = "./data/aave-v4-oracle-sources.json";

export class AaveV4Updater implements DataUpdater {
  name = "Aave V4";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    // Load hub seed config
    const hubSeed = await loadExisting(hubsFile);

    // Step 1: Discover hubs & spokes
    const { spokes } = await fetchAaveV4Configs(hubSeed);

    // Step 2: Discover reserves
    const { reserves, details, maxDynamicConfigKeys } = await fetchAaveV4Reserves(spokes);

    // Enrich spokes with maxDynamicConfigKey per spoke
    for (const fork of Object.keys(spokes)) {
      for (const chain of Object.keys(spokes[fork])) {
        for (const entry of spokes[fork][chain]) {
          entry.dynamicConfigKeyMax =
            maxDynamicConfigKeys[fork]?.[chain]?.[entry.spoke] ?? 0;
        }
      }
    }

    // Step 3: Discover oracles
    const { oracles, sources } = await fetchAaveV4Oracles(spokes, reserves, details);

    return {
      [spokesFile]: spokes,
      [reservesFile]: reserves,
      [reserveDetailsFile]: details,
      [oraclesFile]: oracles,
      [oracleSourcesFile]: sources,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return mergeData(oldData, data);
  }

  defaults = {};
}
