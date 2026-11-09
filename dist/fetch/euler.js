import { existsSync, readFileSync } from "fs";
import { mergeData, sleep } from "../utils.js";
import { EULER_ADDRESSES } from "./euler/constants.js";
import { getAllVaultAddresses, addressesFromChain, getVaultAssets, } from "./euler/fetcher.js";
const configFile = "./config/euler-configs.json";
const vaultsFile = "./data/euler-vaults.json";
const classifiedFile = "./data/euler-oracles-classified.json";
/**
 * Stamps `fixedRate` on vaults whose router resolves to a `FixedRateOracle`:
 * margin-fetcher never lets such a constant set a group price while a live feed
 * exists. Reads the last classification (`update:euler-oracles`), so a new vault
 * is stamped one run after it is classified.
 */
export function withFixedRate(chainId, vaults, classified) {
    return vaults.map(({ underlying, vault }) => ({
        underlying,
        vault,
        ...(classified[chainId]?.[vault.toLowerCase()]?.fixedRate
            ? { fixedRate: true }
            : {}),
    }));
}
export class EulerUpdater {
    name = "Euler";
    async fetchData() {
        const vaults = {
            EULER_V2: {},
        };
        const classified = existsSync(classifiedFile)
            ? JSON.parse(readFileSync(classifiedFile, "utf8"))
            : {};
        const chainEntries = Object.entries(EULER_ADDRESSES);
        for (let i = 0; i < chainEntries.length; i++) {
            const [chainId, addresses] = chainEntries[i];
            try {
                // Step 1: Fetch vault addresses from factory
                const overrides = addressesFromChain(addresses);
                const vaultAddresses = await getAllVaultAddresses(chainId, overrides);
                // Step 2: Fetch underlying asset for each vault
                const vaultsWithAssets = await getVaultAssets(chainId, vaultAddresses);
                vaults.EULER_V2[chainId] = withFixedRate(chainId, vaultsWithAssets, classified);
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
