import { getEvmClient } from "@1delta/providers";
import { DataUpdater } from "../types.js";
import { sleep } from "../utils.js";
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

    const chainEntries = Object.entries(EULER_ADDRESSES);
    for (let i = 0; i < chainEntries.length; i++) {
      const [chainId, addresses] = chainEntries[i];
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

      // Delay between chains to avoid RPC rate limits
      if (i < chainEntries.length - 1) {
        await sleep(1000);
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
