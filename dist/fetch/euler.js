import { mergeData, sleep } from "../utils.js";
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
        const chainEntries = Object.entries(EULER_ADDRESSES);
        for (let i = 0; i < chainEntries.length; i++) {
            const [chainId, addresses] = chainEntries[i];
            try {
                // Step 1: Fetch vault addresses from factory
                const overrides = addressesFromChain(addresses);
                const vaultAddresses = await getAllVaultAddresses(chainId, overrides);
                // Step 2: Fetch underlying asset for each vault
                const vaultsWithAssets = await getVaultAssets(chainId, vaultAddresses);
                vaults.EULER_V2[chainId] = vaultsWithAssets;
            }
            catch (e) {
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
    mergeData(oldData, data, fileKey) {
        return mergeData(oldData, data);
    }
    defaults = {};
}
