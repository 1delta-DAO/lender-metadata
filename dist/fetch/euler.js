import { getEvmClient } from "@1delta/providers";
import { EULER_ADDRESSES } from "./euler/constants.js";
import { getAllVaultAddresses, addressesFromChain } from "./euler/fetcher.js";
const configFile = "./config/euler-configs.json";
const vaultsFile = "./data/euler-vaults.json";
export class EulerUpdater {
    name = "Euler";
    async fetchData() {
        const vaults = { EULER_V2: {} };
        for (const [chainId, addresses] of Object.entries(EULER_ADDRESSES)) {
            try {
                const client = getEvmClient(chainId);
                const overrides = addressesFromChain(addresses);
                const vaultAddresses = await getAllVaultAddresses(client, overrides);
                vaults.EULER_V2[chainId] = vaultAddresses;
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
