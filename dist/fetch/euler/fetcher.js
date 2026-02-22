import { genericFactoryAbi } from "./genericFactory.js";
import { EVAULT_FACTORY_ADDRESS, VAULT_LENS_ADDRESS, } from "./constants.js";
function resolveAddresses(overrides) {
    return {
        factory: overrides?.eVaultFactory ?? EVAULT_FACTORY_ADDRESS,
        lens: overrides?.vaultLens ?? VAULT_LENS_ADDRESS,
    };
}
/** Build overrides from a ChainAddresses config */
export function addressesFromChain(chain) {
    return {
        eVaultFactory: chain.eVaultFactory,
        vaultLens: chain.vaultLens,
    };
}
/**
 * Returns the total number of vaults deployed by the EVault factory.
 */
export async function getVaultCount(client, overrides) {
    const { factory } = resolveAddresses(overrides);
    const length = await client.readContract({
        address: factory,
        abi: genericFactoryAbi,
        functionName: "getProxyListLength",
    });
    return Number(length);
}
/**
 * Fetches all vault addresses from the factory.
 */
export async function getAllVaultAddresses(client, overrides) {
    const { factory } = resolveAddresses(overrides);
    const length = await getVaultCount(client, overrides);
    if (length === 0)
        return [];
    const addresses = await client.readContract({
        address: factory,
        abi: genericFactoryAbi,
        functionName: "getProxyListSlice",
        args: [0n, BigInt(length)],
    });
    return [...addresses];
}
