import type { Address } from "viem";
import { genericFactoryAbi, eVaultAbi } from "./genericFactory.js";
import {
  EVAULT_FACTORY_ADDRESS,
  VAULT_LENS_ADDRESS,
  DEFAULT_BATCH_SIZE,
} from "./constants.js";
import type { ChainAddresses } from "./constants.js";
import { multicallRetryUniversal } from "@1delta/providers";

/** Optional overrides for contract addresses (for non-mainnet deployments) */
export interface FetcherAddressOverrides {
  eVaultFactory?: Address;
  vaultLens?: Address;
}

function resolveAddresses(overrides?: FetcherAddressOverrides) {
  return {
    factory: overrides?.eVaultFactory ?? EVAULT_FACTORY_ADDRESS,
    lens: overrides?.vaultLens ?? VAULT_LENS_ADDRESS,
  };
}

/** Build overrides from a ChainAddresses config */
export function addressesFromChain(
  chain: ChainAddresses,
): FetcherAddressOverrides {
  return {
    eVaultFactory: chain.eVaultFactory,
    vaultLens: chain.vaultLens,
  };
}

/**
 * Returns the total number of vaults deployed by the EVault factory.
 */
export async function getVaultCount(
  chainId: string,
  overrides?: FetcherAddressOverrides,
): Promise<number> {
  const { factory } = resolveAddresses(overrides);
  const [length] = await multicallRetryUniversal({
    chain: chainId,
    calls: [{ address: factory, name: "getProxyListLength", args: [] }],
    abi: genericFactoryAbi,
    allowFailure: false,
  }) as [bigint];
  return Number(length);
}

/**
 * Fetches all vault addresses from the factory in batches to avoid gas limits.
 */
export async function getAllVaultAddresses(
  chainId: string,
  overrides?: FetcherAddressOverrides,
): Promise<Address[]> {
  const { factory } = resolveAddresses(overrides);
  const length = await getVaultCount(chainId, overrides);
  if (length === 0) return [];

  const calls = [];
  for (let start = 0; start < length; start += DEFAULT_BATCH_SIZE) {
    const end = Math.min(start + DEFAULT_BATCH_SIZE, length);
    calls.push({
      address: factory,
      name: "getProxyListSlice" as const,
      args: [BigInt(start), BigInt(end)] as [bigint, bigint],
    });
  }

  const results = await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: genericFactoryAbi,
    allowFailure: false,
  }) as Address[][];

  return results.flat();
}

export interface VaultWithUnderlying {
  underlying: string;
  vault: string;
}

/**
 * Fetches the underlying asset for each vault address via multicall.
 * With allowFailure, the package returns the plain result value or "0x" for failures.
 */
export async function getVaultAssets(
  chainId: string,
  vaultAddresses: Address[],
): Promise<VaultWithUnderlying[]> {
  if (vaultAddresses.length === 0) return [];

  const calls = vaultAddresses.map((vault) => ({
    address: vault,
    name: "asset" as const,
    args: [],
  }));

  const results = await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: eVaultAbi,
    allowFailure: true,
  }) as any[];

  const vaults: VaultWithUnderlying[] = [];
  let skipped = 0;
  for (let i = 0; i < vaultAddresses.length; i++) {
    const asset = results[i];
    if (asset && asset !== "0x") {
      vaults.push({
        underlying: asset as string,
        vault: vaultAddresses[i],
      });
    } else {
      skipped++;
    }
  }

  if (skipped > 0) {
    console.log(
      `Euler: chain ${chainId}: ${vaults.length} vaults resolved, ${skipped} skipped (no asset function)`,
    );
  }

  return vaults;
}
