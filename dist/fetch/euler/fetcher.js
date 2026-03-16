import { genericFactoryAbi, eVaultAbi } from "./genericFactory.js";
import { EVAULT_FACTORY_ADDRESS, VAULT_LENS_ADDRESS, DEFAULT_BATCH_SIZE, } from "./constants.js";
import { multicallRetryUniversal } from "@1delta/providers";
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
export async function getVaultCount(chainId, overrides) {
    const { factory } = resolveAddresses(overrides);
    const [length] = await multicallRetryUniversal({
        chain: chainId,
        calls: [{ address: factory, name: "getProxyListLength", args: [] }],
        abi: genericFactoryAbi,
        allowFailure: false,
    });
    return Number(length);
}
/**
 * Fetches all vault addresses from the factory in batches to avoid gas limits.
 */
export async function getAllVaultAddresses(chainId, overrides) {
    const { factory } = resolveAddresses(overrides);
    const length = await getVaultCount(chainId, overrides);
    if (length === 0)
        return [];
    const calls = [];
    for (let start = 0; start < length; start += DEFAULT_BATCH_SIZE) {
        const end = Math.min(start + DEFAULT_BATCH_SIZE, length);
        calls.push({
            address: factory,
            name: "getProxyListSlice",
            args: [BigInt(start), BigInt(end)],
        });
    }
    const results = await multicallRetryUniversal({
        chain: chainId,
        calls,
        abi: genericFactoryAbi,
        allowFailure: false,
    });
    return results.flat();
}
/**
 * Fetches the underlying asset for each vault address via multicall.
 * With allowFailure, the package returns the plain result value or "0x" for failures.
 */
export async function getVaultAssets(chainId, vaultAddresses) {
    if (vaultAddresses.length === 0)
        return [];
    const calls = vaultAddresses.map((vault) => ({
        address: vault,
        name: "asset",
        args: [],
    }));
    const results = await multicallRetryUniversal({
        chain: chainId,
        calls,
        abi: eVaultAbi,
        allowFailure: true,
    });
    const vaults = [];
    let skipped = 0;
    for (let i = 0; i < vaultAddresses.length; i++) {
        const asset = results[i];
        if (asset && asset !== "0x") {
            vaults.push({
                underlying: asset,
                vault: vaultAddresses[i],
            });
        }
        else {
            skipped++;
        }
    }
    if (skipped > 0) {
        console.log(`Euler: chain ${chainId}: ${vaults.length} vaults resolved, ${skipped} skipped (no asset function)`);
    }
    return vaults;
}
