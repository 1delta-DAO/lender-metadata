import type { Address } from "viem";
import { genericFactoryAbi, eVaultAbi } from "./genericFactory.js";
import {
  EVAULT_FACTORY_ADDRESS,
  VAULT_LENS_ADDRESS,
  DEFAULT_BATCH_SIZE,
} from "./constants.js";
import type { ChainAddresses } from "./constants.js";
import { multicallRetry } from "../utils/index.js";

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
  const [length] = (await multicallRetry({
    chainId,
    contracts: [{ address: factory, abi: genericFactoryAbi, functionName: "getProxyListLength" }],
    allowFailure: false,
  })) as [bigint];
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

  const contracts = [];
  for (let start = 0; start < length; start += DEFAULT_BATCH_SIZE) {
    const end = Math.min(start + DEFAULT_BATCH_SIZE, length);
    contracts.push({
      address: factory,
      abi: genericFactoryAbi,
      functionName: "getProxyListSlice" as const,
      args: [BigInt(start), BigInt(end)] as [bigint, bigint],
    });
  }

  const results = (await multicallRetry({
    chainId,
    contracts,
    allowFailure: false,
  })) as Address[][];

  return results.flat();
}

export interface VaultWithUnderlying {
  underlying: string;
  vault: string;
}

/**
 * Fetches the underlying asset for each vault address via multicall.
 */
export async function getVaultAssets(
  chainId: string,
  vaultAddresses: Address[],
): Promise<VaultWithUnderlying[]> {
  if (vaultAddresses.length === 0) return [];

  const contracts = vaultAddresses.map((vault) => ({
    address: vault,
    abi: eVaultAbi,
    functionName: "asset" as const,
  }));

  const results = (await multicallRetry({
    chainId,
    contracts,
    allowFailure: true,
  })) as { status: string; result?: unknown }[];

  const vaults: VaultWithUnderlying[] = [];
  for (let i = 0; i < vaultAddresses.length; i++) {
    const result = results[i];
    if (result.status === "success") {
      vaults.push({
        underlying: result.result as string,
        vault: vaultAddresses[i],
      });
    } else {
      console.log(
        `Euler: failed to fetch asset for vault ${vaultAddresses[i]} on chain ${chainId}`,
      );
    }
  }

  return vaults;
}
