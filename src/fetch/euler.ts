import { getEvmClient } from "@1delta/providers";
import { DataUpdater } from "../types.js";
import { EULER_ADDRESSES } from "./euler/constants.js";
import { getAllVaultAddresses, addressesFromChain } from "./euler/fetcher.js";

const configFile = "./config/euler-config.json";
const vaultsFile = "./data/euler-vaults.json";

export class EulerUpdater implements DataUpdater {
  name = "Euler";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const vaults: Record<string, Record<string, string[]>> = { EULER_V2: {} };

    for (const [chainId, addresses] of Object.entries(EULER_ADDRESSES)) {
      try {
        const client = getEvmClient(chainId);
        const overrides = addressesFromChain(addresses);
        const vaultAddresses = await getAllVaultAddresses(client, overrides);
        vaults.EULER_V2[chainId] = vaultAddresses;
      } catch (e) {
        console.log(`Euler: failed to fetch vaults for chain ${chainId}:`, e);
      }
    }

    return {
      [configFile]: { EULER_V2: EULER_ADDRESSES },
      [vaultsFile]: vaults,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return data;
  }

  defaults = {};
}
