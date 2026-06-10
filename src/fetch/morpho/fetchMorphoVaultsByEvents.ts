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
import type { MorphoTypeVault } from "./vaultTypes.js";

// Both MetaMorpho v1.0 and v1.1 factories emit this signature.
const CREATE_META_MORPHO = parseAbiItem(
  "event CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)",
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
    out.set(vault, { vault, underlying, ...(name ? { name } : {}) });
  });
  return [...out.values()];
}

const ERC4626_META_ABI = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
]);

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

  const [assets, names] = await Promise.all([read("asset"), read("name")]);
  const out: MorphoTypeVault[] = [];
  for (let i = 0; i < addrs.length; i++) {
    const underlying = unwrap(assets[i]);
    if (typeof underlying !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(underlying))
      continue;
    const rawName = unwrap(names[i]);
    const name = typeof rawName === "string" ? rawName.trim() : "";
    out.push({
      vault: addrs[i],
      underlying: underlying.toLowerCase(),
      ...(name ? { name } : {}),
    });
  }
  return out;
}
