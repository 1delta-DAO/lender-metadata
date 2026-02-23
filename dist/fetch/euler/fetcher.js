import { genericFactoryAbi, eVaultAbi } from "./genericFactory.js";
import { EVAULT_FACTORY_ADDRESS, VAULT_LENS_ADDRESS, } from "./constants.js";
import { multicallRetry } from "../utils/index.js";
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
/**
 * Fetches the underlying asset for each vault address via multicall.
 */
export async function getVaultAssets(chainId, vaultAddresses) {
    if (vaultAddresses.length === 0)
        return [];
    const contracts = vaultAddresses.map((vault) => ({
        address: vault,
        abi: eVaultAbi,
        functionName: "asset",
    }));
    const results = (await multicallRetry({
        chainId,
        contracts,
        allowFailure: true,
    }));
    const vaults = [];
    for (let i = 0; i < vaultAddresses.length; i++) {
        const result = results[i];
        if (result.status === "success") {
            vaults.push({
                underlying: result.result,
                vault: vaultAddresses[i],
            });
        }
        else {
            console.log(`Euler: failed to fetch asset for vault ${vaultAddresses[i]} on chain ${chainId}`);
        }
    }
    return vaults;
}
