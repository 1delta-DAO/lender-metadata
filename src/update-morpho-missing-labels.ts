// ============================================================================
// Backfill labels for Morpho Blue markets that have no name in
// data/lender-labels.json.
//
// Two sources:
//   - default: markets the allocator API knows about (falls back to the generic
//     "Morpho Blue" name) for the given chains.
//   - `--from-config`: every MORPHO_BLUE market id already in
//     config/morpho-type-markets.json, across all chains with a core. Use this
//     to label chains the allocator does not serve (e.g. Robinhood) and to
//     close every remaining gap in one pass.
//
// For each id it reads `idToMarketParams(id)` on the Morpho core plus the
// loan/collateral `symbol()` on-chain, then writes the name in the existing
// convention:  "Morpho <collateral>-<loan> <lltv%>"  /  "MB ...".
//
// If exactly one side's symbol is unfetchable, "unknown" is used for that side
// (so "Morpho unknown-USDG 62"); idle markets (zero loan/collateral/oracle) and
// markets with *both* symbols unfetchable are skipped.
//
// Usage: `tsx src/update-morpho-missing-labels.ts [chains] [maxRiskScore]`
//        `tsx src/update-morpho-missing-labels.ts --from-config`
// ============================================================================

import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { numberToBps, sortRecord } from "./utils.js";

const LABELS_FILE = "./data/lender-labels.json";
const ADDRESSES_FILE = "./config/morpho-addresses.json";
const MARKETS_FILE = "./config/morpho-type-markets.json";
const API = "https://portal.1delta.io/v1/data/lending/lenders";
const KEY_PREFIX = "MORPHO_BLUE_";
const ZERO = "0x0000000000000000000000000000000000000000";

const CORE_ABI = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);

const unwrap = (r: unknown) =>
  r && typeof r === "object" && "result" in (r as any) ? (r as any).result : r;

/** A usable token symbol: non-empty and not a hex/`0x` blob (garbage read). */
const cleanSymbol = (s: unknown): string | undefined =>
  typeof s === "string" && s.trim() && !/^0x[0-9a-fA-F]*$/.test(s.trim())
    ? s.trim()
    : undefined;

/**
 * Resolve token `symbol()`s on `chainId`. Tries the provider's multicall first;
 * for any token left unresolved (e.g. a chain whose default RPCs return empty
 * data) it retries via the configured public fallback RPCs. Returns a lowercase
 * address → symbol map.
 */
async function readSymbols(
  chainId: string,
  tokens: string[],
): Promise<Map<string, string>> {
  const symbolOf = new Map<string, string>();
  if (tokens.length === 0) return symbolOf;

  const apply = (res: unknown[]) =>
    tokens.forEach((t, i) => {
      if (symbolOf.has(t)) return;
      const s = cleanSymbol(unwrap(res[i]));
      if (s) symbolOf.set(t, s);
    });

  try {
    apply(
      (await multicallRetryUniversal({
        chain: chainId,
        calls: tokens.map((address) => ({ address, name: "symbol", args: [] })),
        abi: SYMBOL_ABI,
        allowFailure: true,
      })) as unknown[],
    );
  } catch {
    /* leave unresolved */
  }
  return symbolOf;
}

type MarketParams = {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  lltv: any;
};

const toParams = (p: any): MarketParams | null => {
  if (!p) return null;
  const loanToken = String(p.loanToken ?? p[0] ?? "").toLowerCase();
  const collateralToken = String(p.collateralToken ?? p[1] ?? "").toLowerCase();
  const oracle = String(p.oracle ?? p[2] ?? "").toLowerCase();
  const lltv = p.lltv ?? p[4];
  if (!/^0x[0-9a-f]{40}$/.test(loanToken) || !/^0x[0-9a-f]{40}$/.test(collateralToken))
    return null;
  return { loanToken, collateralToken, oracle, lltv };
};

/** Idle / placeholder market — zero loan, collateral, or oracle. Not a real market. */
const isIdle = (m: MarketParams) =>
  m.loanToken === ZERO || m.collateralToken === ZERO || !m.oracle || m.oracle === ZERO;

/**
 * Read `idToMarketParams(id)` for every id on `chainId`, index-aligned with
 * `ids`. Markets whose params don't resolve are left `null`.
 */
async function readMarketParams(
  chainId: string,
  core: string,
  ids: string[],
): Promise<(MarketParams | null)[]> {
  const out: (MarketParams | null)[] = ids.map(() => null);
  try {
    const res = (await multicallRetryUniversal({
      chain: chainId,
      calls: ids.map((id) => ({ address: core, name: "idToMarketParams", args: [id] })),
      abi: CORE_ABI,
      allowFailure: true,
    })) as unknown[];
    ids.forEach((_, i) => (out[i] = toParams(unwrap(res[i]))));
  } catch {
    /* leave unresolved */
  }
  return out;
}

/** Markets the API serves with the generic fallback name, grouped by chainId. */
async function fetchUnnamed(
  chains: string,
  maxRiskScore: string,
): Promise<Record<string, string[]>> {
  const url = `${API}?chains=${chains}&maxRiskScore=${maxRiskScore}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Allocator API ${res.status} ${res.statusText}`);
  const json: any = await res.json();
  const items: any[] = json?.data?.items ?? [];

  const labels = readJsonFile(LABELS_FILE);
  const names: Record<string, string> = labels.names ?? {};

  const byChain: Record<string, string[]> = {};
  for (const it of items) {
    const key = String(it?.lenderInfo?.key ?? "");
    if (!key.startsWith(KEY_PREFIX)) continue;
    // Already labelled in our metadata → nothing to do.
    if (names[key]) continue;
    const chainId = String(it?.chainId ?? "");
    (byChain[chainId] ??= []).push(key);
  }
  return byChain;
}

/** Every unlabelled MORPHO_BLUE market id in the config, grouped by chainId. */
function fetchFromConfig(): Record<string, string[]> {
  const markets = readJsonFile(MARKETS_FILE);
  const names: Record<string, string> = readJsonFile(LABELS_FILE).names ?? {};
  const fork: Record<string, string[]> = markets.MORPHO_BLUE ?? {};

  const byChain: Record<string, string[]> = {};
  for (const [chainId, ids] of Object.entries(fork)) {
    for (const id of ids) {
      const key = KEY_PREFIX + String(id).replace(/^0x/, "").toUpperCase();
      if (names[key]) continue; // already labelled
      (byChain[chainId] ??= []).push(key);
    }
  }
  return byChain;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromConfig = args.includes("--from-config");
  const positional = args.filter((a) => !a.startsWith("--"));
  const chains = positional[0] || "1";
  const maxRiskScore = positional[1] || "6";

  const byChain = fromConfig
    ? fetchFromConfig()
    : await fetchUnnamed(chains, maxRiskScore);
  const total = Object.values(byChain).reduce((a, l) => a + l.length, 0);
  console.log(
    `Found ${total} unlabelled Morpho markets across ${Object.keys(byChain).length} chain(s)` +
      (fromConfig ? " (source: config)" : ` (source: allocator, chains=${chains})`),
  );

  const addresses: Record<string, { morpho?: string }> =
    readJsonFile(ADDRESSES_FILE);
  const labels = readJsonFile(LABELS_FILE);
  labels.names ??= {};
  labels.shortNames ??= {};

  let added = 0;
  const skipped: string[] = [];

  for (const [chainId, keys] of Object.entries(byChain)) {
    const core = addresses[chainId]?.morpho;
    if (!core) {
      console.warn(`chain ${chainId}: no Morpho core in config; skipping`);
      skipped.push(...keys);
      continue;
    }
    const ids = keys.map((k) => `0x${k.slice(KEY_PREFIX.length).toLowerCase()}`);

    let parsed: (MarketParams | null)[];
    let symbolOf: Map<string, string>;
    try {
      parsed = await readMarketParams(chainId, core, ids);
      const tokenSet = new Set<string>();
      for (const m of parsed) if (m) tokenSet.add(m.loanToken), tokenSet.add(m.collateralToken);
      symbolOf = await readSymbols(chainId, [...tokenSet]);
    } catch (err) {
      console.warn(`chain ${chainId}: on-chain read failed: ${(err as any)?.message ?? err}`);
      skipped.push(...keys);
      continue;
    }

    for (let i = 0; i < keys.length; i++) {
      const m = parsed[i];
      // Skip params we couldn't read and idle/placeholder markets.
      if (!m || isIdle(m)) {
        skipped.push(keys[i]);
        continue;
      }
      const collSym = symbolOf.get(m.collateralToken);
      const loanSym = symbolOf.get(m.loanToken);
      // Both unfetchable → nothing meaningful to name it; skip.
      if (!collSym && !loanSym) {
        skipped.push(keys[i]);
        continue;
      }
      // One side unfetchable → label it "unknown" rather than dropping the market.
      const coll = collSym ?? "unknown";
      const loan = loanSym ?? "unknown";
      const bps = numberToBps(m.lltv as any);
      labels.names[keys[i]] = `Morpho ${coll}-${loan} ${bps}`;
      labels.shortNames[keys[i]] = `MB ${coll}-${loan} ${bps}`;
      added++;
      console.log(`  ${keys[i].slice(0, 24)}… -> ${labels.names[keys[i]]}`);
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
      `Skipped ${skipped.length} (no on-chain params/symbols): ${skipped.map((k) => k.slice(0, 20)).join(", ")}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
