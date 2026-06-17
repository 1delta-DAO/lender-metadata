// ============================================================================
// Backfill labels for Silo V2/V3 markets the allocator API knows about but
// data/lender-labels.json has no name for (so the API serves a null name).
// These are silos the Silo indexer (the main SiloUpdater's source) doesn't
// return, so the regular pipeline never labels them.
//
// Each label key is `SILO_V{N}_<UPPER_CONFIG_ADDRESS>`. For each we read the
// SiloConfig on-chain: `getSilos()` -> two silos -> each silo's `asset()` ->
// `symbol()`, then write "Silo V{N} <sym0>/<sym1>" / "S{N} <sym0>/<sym1>",
// matching src/fetch/silo-labels.ts.
//
// Usage: `tsx src/update-silo-missing-labels.ts [chains] [maxRiskScore]`
// (defaults: chains=1,10,56,146,42161,8453,43114, maxRiskScore=10).
// ============================================================================

import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";

const LABELS_FILE = "./data/lender-labels.json";
const API = "https://portal.1delta.io/v1/data/lending/lenders";
const DEFAULT_CHAINS = "1,10,56,146,42161,8453,43114";

const CONFIG_ABI = parseAbi([
  "function getSilos() view returns (address silo0, address silo1)",
]);
const SILO_ABI = parseAbi(["function asset() view returns (address)"]);
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);

const PREFIX = {
  "2": { long: "Silo V2", short: "S2" },
  "3": { long: "Silo V3", short: "S3" },
} as const;

const unwrap = (r: unknown) =>
  r && typeof r === "object" && "result" in (r as any) ? (r as any).result : r;
const isAddr = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Silo keys the API serves with no label in our file, grouped by chainId. */
async function fetchUnnamed(
  chains: string,
  maxRiskScore: string,
): Promise<Record<string, string[]>> {
  const res = await fetch(`${API}?chains=${chains}&maxRiskScore=${maxRiskScore}`);
  if (!res.ok) throw new Error(`Allocator API ${res.status} ${res.statusText}`);
  const items: any[] = (await res.json())?.data?.items ?? [];
  const names: Record<string, string> = readJsonFile(LABELS_FILE).names ?? {};

  const byChain: Record<string, string[]> = {};
  for (const it of items) {
    const key = String(it?.lenderInfo?.key ?? "");
    if (!/^SILO_V[23]_/.test(key) || names[key]) continue;
    (byChain[String(it?.chainId ?? "")] ??= []).push(key);
  }
  return byChain;
}

async function main(): Promise<void> {
  const [chainsArg, riskArg] = process.argv.slice(2);
  const chains = chainsArg || DEFAULT_CHAINS;
  const maxRiskScore = riskArg || "10";

  const byChain = await fetchUnnamed(chains, maxRiskScore);
  const total = Object.values(byChain).reduce((a, l) => a + l.length, 0);
  console.log(
    `Found ${total} unnamed Silo markets across ${Object.keys(byChain).length} chain(s)`,
  );

  const labels = readJsonFile(LABELS_FILE);
  labels.names ??= {};
  labels.shortNames ??= {};

  let added = 0;
  const skipped: string[] = [];

  for (const [chainId, keys] of Object.entries(byChain)) {
    const configs = keys.map((key) => ({
      key,
      version: key.slice("SILO_V".length, "SILO_V".length + 1) as "2" | "3",
      addr: `0x${key.replace(/^SILO_V[23]_/, "").toLowerCase()}`,
    }));

    try {
      // 1) config -> (silo0, silo1)
      const silosRes = (await multicallRetryUniversal({
        chain: chainId,
        calls: configs.map((c) => ({ address: c.addr, name: "getSilos", args: [] })),
        abi: CONFIG_ABI,
        allowFailure: true,
      })) as unknown[];
      const siloPairs = configs.map((_, i) => {
        const v: any = unwrap(silosRes[i]);
        const a = Array.isArray(v) ? v : [v?.silo0 ?? v?.[0], v?.silo1 ?? v?.[1]];
        return [String(a[0] ?? "").toLowerCase(), String(a[1] ?? "").toLowerCase()];
      });

      // 2) silo -> asset()
      const silos = [...new Set(siloPairs.flat().filter(isAddr))];
      const assetRes = (await multicallRetryUniversal({
        chain: chainId,
        calls: silos.map((address) => ({ address, name: "asset", args: [] })),
        abi: SILO_ABI,
        allowFailure: true,
      })) as unknown[];
      const assetOf = new Map<string, string>();
      silos.forEach((s, i) => {
        const a = unwrap(assetRes[i]);
        if (isAddr(a)) assetOf.set(s, a.toLowerCase());
      });

      // 3) asset -> symbol()
      const assets = [...new Set([...assetOf.values()])];
      const symRes = (await multicallRetryUniversal({
        chain: chainId,
        calls: assets.map((address) => ({ address, name: "symbol", args: [] })),
        abi: SYMBOL_ABI,
        allowFailure: true,
      })) as unknown[];
      const symbolOf = new Map<string, string>();
      assets.forEach((a, i) => {
        const s = unwrap(symRes[i]);
        if (typeof s === "string" && s) symbolOf.set(a, s);
      });

      const symOfSilo = (silo: string) => {
        const asset = assetOf.get(silo);
        return asset ? symbolOf.get(asset) : undefined;
      };

      configs.forEach((c, i) => {
        const [s0, s1] = siloPairs[i];
        const sym0 = symOfSilo(s0);
        const sym1 = symOfSilo(s1);
        if (!sym0 || !sym1) {
          skipped.push(c.key);
          return;
        }
        const p = PREFIX[c.version];
        labels.names[c.key] = `${p.long} ${sym0}/${sym1}`;
        labels.shortNames[c.key] = `${p.short} ${sym0}/${sym1}`;
        added++;
        console.log(`  ${c.key.slice(0, 22)}… -> ${labels.names[c.key]}`);
      });
    } catch (err) {
      console.warn(`chain ${chainId}: on-chain read failed: ${(err as any)?.message ?? err}`);
      skipped.push(...keys);
    }
  }

  labels.names = sortRecord(labels.names);
  labels.shortNames = sortRecord(labels.shortNames);

  const writeResult = await writeTextIfChanged(
    LABELS_FILE,
    JSON.stringify(labels, null, 2) + "\n",
  );
  console.log(`Added ${added} labels; file ${writeResult}.`);
  if (skipped.length) {
    console.warn(
      `Skipped ${skipped.length} (no on-chain silos/symbols): ${skipped.map((k) => k.slice(0, 20)).join(", ")}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
