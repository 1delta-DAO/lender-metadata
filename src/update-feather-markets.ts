// ============================================================================
// Fill the MORPHO_BLUE section of config/morpho-type-markets.json with the
// market IDs used by the Feather-indexed vaults (Celo / Sei / Lisk / Soneium /
// TAC / Hemi / Kaia). Append-only: existing market IDs are never removed.
//
// Feather's GraphQL does not expose the on-chain bytes32 market id, so we
// enumerate each vault's `withdrawQueue` on-chain (the markets a MetaMorpho
// vault lends to) and union the resulting ids. Vault addresses are read from
// the already-generated data/morpho-type-vaults.json, so this must run after
// update:feather-vaults. Primarily closes the TAC/Kaia gap the main
// MorphoBlueUpdater (subgraph/API) leaves open.
// ============================================================================

import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { FEATHER_CHAIN_IDS } from "./fetch/morpho/fetchFeatherApi.js";
import type { MorphoTypeVaultsByFork } from "./fetch/morpho/vaultTypes.js";

const VAULTS_FILE = "./data/morpho-type-vaults.json";
const MARKETS_FILE = "./config/morpho-type-markets.json";
const FORK = "MORPHO_BLUE";

const QUEUE_ABI = parseAbi([
  "function withdrawQueueLength() view returns (uint256)",
  "function withdrawQueue(uint256) view returns (bytes32)",
]);

const isHex64 = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

const unwrap = (r: unknown): unknown =>
  r && typeof r === "object" && "result" in (r as any) ? (r as any).result : r;

/** Enumerate the market ids backing a set of vaults on one chain. */
async function marketIdsForChain(
  chainId: string,
  vaults: string[],
): Promise<string[]> {
  if (vaults.length === 0) return [];

  // Phase 1: withdrawQueueLength() per vault.
  const lens = await multicallRetryUniversal({
    chain: chainId,
    calls: vaults.map((address) => ({
      address,
      name: "withdrawQueueLength",
      args: [],
    })),
    abi: QUEUE_ABI,
    allowFailure: true,
  });
  const lengths = (lens as unknown[]).map((r) => {
    const v = unwrap(r);
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });

  // Phase 2: withdrawQueue(i) for every (vault, index).
  const calls: { address: string; name: string; args: [bigint] }[] = [];
  vaults.forEach((address, vi) => {
    for (let i = 0; i < lengths[vi]; i++) {
      calls.push({ address, name: "withdrawQueue", args: [BigInt(i)] });
    }
  });
  if (calls.length === 0) return [];

  const raw = await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: QUEUE_ABI,
    allowFailure: true,
  });

  const ids = new Set<string>();
  for (const r of raw as unknown[]) {
    const v = unwrap(r);
    if (isHex64(v)) ids.add((v as string).toLowerCase());
  }
  return [...ids];
}

async function main(): Promise<void> {
  const vaultsData: MorphoTypeVaultsByFork = readJsonFile(VAULTS_FILE);
  const byChain = vaultsData[FORK] ?? {};

  let markets: Record<string, Record<string, string[]>> = {};
  try {
    markets = readJsonFile(MARKETS_FILE);
  } catch {
    markets = {};
  }
  if (!markets[FORK]) markets[FORK] = {};

  let added = 0;
  for (const chainId of FEATHER_CHAIN_IDS) {
    const vaults = (byChain[chainId] ?? []).map((v) => v.vault.toLowerCase());
    if (vaults.length === 0) continue;
    let ids: string[] = [];
    try {
      ids = await marketIdsForChain(chainId, vaults);
    } catch (err) {
      console.warn(`Market-id enumeration failed for chain ${chainId}:`, err);
      continue;
    }
    const existing = new Set(
      (markets[FORK][chainId] ?? []).map((s) => s.toLowerCase()),
    );
    const before = existing.size;
    for (const id of ids) existing.add(id);
    added += existing.size - before;
    markets[FORK][chainId] = [...existing].sort((a, b) => a.localeCompare(b));
    console.log(
      `chain ${chainId}: ${vaults.length} vaults -> ${ids.length} market ids (${existing.size} total)`,
    );
  }

  const writeResult = await writeTextIfChanged(
    MARKETS_FILE,
    JSON.stringify(markets, null, 2) + "\n",
  );
  console.log(`Added ${added} new market ids; file ${writeResult}.`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
