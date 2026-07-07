// ============================================================================
// Discover MetaMorpho (Morpho Blue) vaults directly from a MetaMorpho factory's
// `CreateMetaMorpho` events. Used for chains that have a Morpho Blue deployment
// but no Morpho-API / Feather / Mystic vault coverage (e.g. Abstract), so the
// dedicated vault jobs can't otherwise discover their vaults.
//
// The event itself carries `asset` and `name`, so no extra on-chain reads are
// needed — the result is a pure on-chain artifact in the unified
// `MorphoTypeVault` shape consumed by the vault-update jobs.
// ============================================================================

import { parseAbi, parseAbiItem } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { scanContractEvents } from "./eventScan.js";
import { detectVaultVersions } from "./vaultVersion.js";
import type { MorphoTypeVault } from "./vaultTypes.js";

// Both MetaMorpho v1.0 and v1.1 factories emit this signature.
const CREATE_META_MORPHO = parseAbiItem(
  "event CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)",
);

// Vaults V2 factory create event. Unlike CreateMetaMorpho it carries no name/
// symbol (event topic0/type layout verified on-chain against the Pharos
// `vaultV2Factory`), so names are completed with a follow-up `name()` read.
const CREATE_VAULT_V2 = parseAbiItem(
  "event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed vaultV2)",
);

/**
 * Return every MetaMorpho vault created by `factory` on `chainId`, read from
 * its `CreateMetaMorpho` events. Only covers MetaMorpho v1.0 / v1.1 factories
 * (not the newer Vault V2 factory, which emits a different event).
 *
 * Throws if the chain's RPC is too restrictive to scan within the call budget,
 * or unreachable — callers should catch per-chain and continue.
 */
export async function fetchMorphoVaultsByEvents(
  chainId: string,
  factory: string,
): Promise<MorphoTypeVault[]> {
  const out = new Map<string, MorphoTypeVault>();
  await scanContractEvents(chainId, factory, CREATE_META_MORPHO, (l) => {
    const vault = String(l.args?.metaMorpho ?? "").toLowerCase();
    const underlying = String(l.args?.asset ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(vault) || !/^0x[0-9a-f]{40}$/.test(underlying))
      return;
    const name = typeof l.args?.name === "string" ? l.args.name.trim() : "";
    // `CreateMetaMorpho` is the MetaMorpho v1.0/v1.1 factory event, so every
    // vault discovered here is V1 by construction (Vaults V2 uses a different
    // factory + event).
    out.set(vault, {
      vault,
      underlying,
      ...(name ? { name } : {}),
      version: "v1",
    });
  });
  return [...out.values()];
}

const ERC4626_META_ABI = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
]);

/**
 * Return every Vaults V2 vault created by `factory` on `chainId`, read from its
 * `CreateVaultV2` events. Used for chains that have a Vaults V2 factory but no
 * MetaMorpho v1 factory / API coverage (e.g. Pharos). The event carries the
 * underlying `asset` but no name, so names are filled in with a single batched
 * `name()` read. Every vault discovered here is `v2` by construction.
 *
 * Throws if the chain's RPC is too restrictive to scan within the call budget,
 * or unreachable — callers should catch per-chain and continue.
 */
export async function fetchMorphoVaultV2ByEvents(
  chainId: string,
  factory: string,
): Promise<MorphoTypeVault[]> {
  const assetOf = new Map<string, string>(); // vault -> underlying
  await scanContractEvents(chainId, factory, CREATE_VAULT_V2, (l) => {
    const vault = String(l.args?.vaultV2 ?? "").toLowerCase();
    const underlying = String(l.args?.asset ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(vault) || !/^0x[0-9a-f]{40}$/.test(underlying))
      return;
    assetOf.set(vault, underlying);
  });

  const vaults = [...assetOf.keys()];
  if (vaults.length === 0) return [];

  // The create event has no name — read it once for every discovered vault.
  let names: unknown[] = [];
  try {
    names = (await multicallRetryUniversal({
      chain: chainId,
      calls: vaults.map((address) => ({ address, name: "name", args: [] })),
      abi: ERC4626_META_ABI,
      allowFailure: true,
    })) as unknown[];
  } catch {
    names = vaults.map(() => undefined);
  }
  const unwrap = (r: unknown) =>
    r && typeof r === "object" && "result" in (r as any) ? (r as any).result : r;

  return vaults.map((vault, i) => {
    const rawName = unwrap(names[i]);
    const name = typeof rawName === "string" ? rawName.trim() : "";
    return {
      vault,
      underlying: assetOf.get(vault)!,
      ...(name ? { name } : {}),
      version: "v2" as const,
    };
  });
}

/**
 * Complete an explicit list of vault addresses into `{ vault, underlying, name }`
 * by reading `asset()` and `name()` on-chain. Use this for chains where vaults
 * are known by address but cannot be discovered from a factory (no factory in
 * config) or any indexer. Vaults whose `asset()` is unreadable are skipped.
 */
export async function fetchMorphoVaultsByAddress(
  chainId: string,
  addresses: string[],
): Promise<MorphoTypeVault[]> {
  if (addresses.length === 0) return [];
  const addrs = addresses.map((a) => a.toLowerCase());
  const read = async (name: "asset" | "name") =>
    (await multicallRetryUniversal({
      chain: chainId,
      calls: addrs.map((address) => ({ address, name, args: [] })),
      abi: ERC4626_META_ABI,
      allowFailure: true,
    })) as unknown[];

  const unwrap = (r: unknown) =>
    r && typeof r === "object" && "result" in (r as any) ? (r as any).result : r;

  const [assets, names, versions] = await Promise.all([
    read("asset"),
    read("name"),
    detectVaultVersions(chainId, addrs),
  ]);
  const out: MorphoTypeVault[] = [];
  for (let i = 0; i < addrs.length; i++) {
    const underlying = unwrap(assets[i]);
    if (typeof underlying !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(underlying))
      continue;
    const rawName = unwrap(names[i]);
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const version = versions[i];
    out.push({
      vault: addrs[i],
      underlying: underlying.toLowerCase(),
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
    });
  }
  return out;
}
