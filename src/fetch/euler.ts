import { getEvmClient } from "@1delta/providers";
import { DataUpdater } from "../types.js";
import { EULER_ADDRESSES } from "./euler/constants.js";
import {
  getAllVaultAddresses,
  addressesFromChain,
  getVaultAssets,
} from "./euler/fetcher.js";
import type { VaultWithUnderlying } from "./euler/fetcher.js";

const configFile = "./config/euler-configs.json";
const vaultsFile = "./data/euler-vaults.json";

export class EulerUpdater implements DataUpdater {
  name = "Euler";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const vaults: Record<string, Record<string, VaultWithUnderlying[]>> = {
      EULER_V2: {},
    };

    for (const [chainId, addresses] of Object.entries(EULER_ADDRESSES)) {
      try {
        // Step 1: Fetch vault addresses from factory
        const client = getEvmClient(chainId);
        const overrides = addressesFromChain(addresses);
        const vaultAddresses = await getAllVaultAddresses(client, overrides);

        // Step 2: Fetch underlying asset for each vault
        const vaultsWithAssets = await getVaultAssets(chainId, vaultAddresses);
        vaults.EULER_V2[chainId] = vaultsWithAssets;
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
