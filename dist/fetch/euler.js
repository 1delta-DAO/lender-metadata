import { getEvmClient } from "@1delta/providers";
import { EULER_ADDRESSES } from "./euler/constants.js";
import { getAllVaultAddresses, addressesFromChain, getVaultAssets, } from "./euler/fetcher.js";
const configFile = "./config/euler-configs.json";
const vaultsFile = "./data/euler-vaults.json";
export class EulerUpdater {
    name = "Euler";
    async fetchData() {
        const vaults = {
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
            }
            catch (e) {
                console.log(`Euler: failed to fetch vaults for chain ${chainId}:`, e);
            }
        }
        return {
            [configFile]: { EULER_V2: EULER_ADDRESSES },
            [vaultsFile]: vaults,
        };
    }
    mergeData(oldData, data, fileKey) {
        return data;
    }
    defaults = {};
}
