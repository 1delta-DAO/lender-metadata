import type { Address } from "viem";
import { zeroAddress } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { lendingResolverAbi, vaultResolverAbi, fTokenAbi } from "./abi.js";
import type { FluidResolvers } from "./constants.js";

export interface FluidVaultAsset {
  underlying: string;
  fToken: string | null;
}

export interface FluidVaultSide {
  assets: FluidVaultAsset[];
  dex: string | null;
  smartLending: string | null;
}

export interface FluidVaultMeta {
  vaultId: number;
  type: number;
  supply: FluidVaultSide;
  borrow: FluidVaultSide;
}

export interface FluidFTokenMeta {
  underlying: string;
  symbol: string;
  isNativeUnderlying: boolean;
}

function isOk(x: unknown): boolean {
  return x !== undefined && x !== null && x !== "0x";
}

export async function getAllVaultAddresses(
  chainId: string,
  resolvers: FluidResolvers
): Promise<Address[]> {
  const [list] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      {
        address: resolvers.vaultResolver,
        name: "getAllVaultsAddresses",
        args: [],
      },
    ],
    abi: vaultResolverAbi,
    allowFailure: false,
  })) as [Address[]];
  return list ?? [];
}

export async function getAllFTokenAddresses(
  chainId: string,
  resolvers: FluidResolvers
): Promise<Address[]> {
  const [list] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      {
        address: resolvers.lendingResolver,
        name: "getAllFTokens",
        args: [],
      },
    ],
    abi: lendingResolverAbi,
    allowFailure: false,
  })) as [Address[]];
  return list ?? [];
}

export async function getFTokenMetas(
  chainId: string,
  fTokens: Address[]
): Promise<Record<string, FluidFTokenMeta>> {
  if (fTokens.length === 0) return {};

  const calls = fTokens.flatMap((ft) => [
    { address: ft, name: "asset" as const, args: [] },
    { address: ft, name: "symbol" as const, args: [] },
    { address: ft, name: "isNativeUnderlying" as const, args: [] },
  ]);

  const results = (await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: fTokenAbi,
    allowFailure: true,
  })) as any[];

  const out: Record<string, FluidFTokenMeta> = {};
  for (let i = 0; i < fTokens.length; i++) {
    const asset = results[i * 3];
    const symbol = results[i * 3 + 1];
    const isNative = results[i * 3 + 2];
    if (!isOk(asset) || !isOk(symbol)) continue;
    out[fTokens[i].toLowerCase()] = {
      underlying: (asset as string).toLowerCase(),
      symbol: symbol as string,
      isNativeUnderlying: Boolean(isNative),
    };
  }
  return out;
}

/** Builds a map: underlying (lowercased) → fToken address (lowercased). */
export function buildFTokensByUnderlying(
  fTokenMetas: Record<string, FluidFTokenMeta>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [fToken, meta] of Object.entries(fTokenMetas)) {
    out[meta.underlying] = fToken;
  }
  return out;
}

function buildSide(
  token0: Address,
  token1: Address,
  dexOrLiquidity: Address,
  fTokensByUnderlying: Record<string, string>
): FluidVaultSide {
  const isSmart = token1 !== zeroAddress;
  const underlyings = isSmart
    ? [token0.toLowerCase(), token1.toLowerCase()]
    : [token0.toLowerCase()];
  return {
    assets: underlyings.map((underlying) => ({
      underlying,
      fToken: fTokensByUnderlying[underlying] ?? null,
    })),
    dex: isSmart ? dexOrLiquidity.toLowerCase() : null,
    smartLending: null,
  };
}

export async function getVaultMetas(
  chainId: string,
  vaults: Address[],
  fTokensByUnderlying: Record<string, string>,
  resolvers: FluidResolvers
): Promise<Record<string, FluidVaultMeta>> {
  if (vaults.length === 0) return {};

  const calls = vaults.map((vault) => ({
    address: resolvers.vaultResolver,
    name: "getVaultEntireData" as const,
    args: [vault] as const,
  }));

  const results = (await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: vaultResolverAbi,
    allowFailure: true,
  })) as any[];

  const out: Record<string, FluidVaultMeta> = {};
  for (let i = 0; i < vaults.length; i++) {
    const r = results[i];
    if (!r || r === "0x" || !r.constantVariables) continue;

    const c = r.constantVariables;
    const supplyToken0 = c.supplyToken.token0 as Address;
    const supplyToken1 = c.supplyToken.token1 as Address;
    const borrowToken0 = c.borrowToken.token0 as Address;
    const borrowToken1 = c.borrowToken.token1 as Address;
    const supplyEntryPoint = c.supply as Address;
    const borrowEntryPoint = c.borrow as Address;

    out[vaults[i].toLowerCase()] = {
      vaultId: Number(c.vaultId),
      type: Number(c.vaultType),
      supply: buildSide(
        supplyToken0,
        supplyToken1,
        supplyEntryPoint,
        fTokensByUnderlying
      ),
      borrow: buildSide(
        borrowToken0,
        borrowToken1,
        borrowEntryPoint,
        fTokensByUnderlying
      ),
    };
  }
  return out;
}
