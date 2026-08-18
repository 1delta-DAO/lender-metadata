// ============================================================================
// Fill `curatorName` on data/morpho-type-vaults.json entries (MORPHO_BLUE
// section) — the chains served by the on-chain fetcher have no Morpho-API
// coverage, so their consumers can never learn WHO runs a vault; three
// Robinhood vaults all rendered as "Morpho · USDG" with no curator, which
// makes them indistinguishable for integrators.
//
// Resolution, in descending order of authority (a lower rung only fills a
// BLANK — it never overwrites a stored name):
//   1. MANUAL_CURATORS override (chain → vault → name) — for curators no
//      other source can know.
//   2. The Morpho API's global curator roster (`curators { addresses }`),
//      joined on the vault's on-chain `curator()` / `owner()` address.
//      Curator entities reuse the same addresses across chains (verified:
//      Steakhouse's Robinhood curator address is in the roster under chain 1),
//      so the join works on chains the API does not index. Addresses claimed
//      by MORE THAN ONE roster entity (B.Protocol / Block Analitica share 4)
//      are dropped as ambiguous rather than guessed. Roster hits DO refresh a
//      stored name — the roster is the authority.
//   3. A conservative parse of the vault's own name ("Purinta USDG" →
//      "Purinta"). Accepted only when the curator run TERMINATES on the asset
//      symbol / a structural word with something left over — a name consumed
//      whole ("RHVault") is a vault name, not a curator, and yields nothing.
//
// Append-only on the file: entries are never removed, and no rung ever
// CLEARS a stored curatorName.
//
// Optional CLI chain-id filter: `tsx src/update-vault-curators.ts 4663`.
// ============================================================================

import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import type {
  MorphoTypeVault,
  MorphoTypeVaultsByFork,
} from "./fetch/morpho/vaultTypes.js";

const VAULTS_FILE = "./data/morpho-type-vaults.json";
const FORK = "MORPHO_BLUE";
const MORPHO_API_URL = "https://blue-api.morpho.org/graphql";

// Curators no on-chain or roster source can name — the last-resort rung, and
// the only one a human maintains. Keys are lowercased chainId → vault address.
const MANUAL_CURATORS: Record<string, Record<string, string>> = {};

const CHAIN_FILTER = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Rung 2 — the Morpho curator roster, keyed by address across ALL chains.
// ---------------------------------------------------------------------------

const ROSTER_QUERY = `query {
  curators(first: 1000) {
    items { name verified addresses { address chainId } }
  }
}`;

/** address (lowercased) → curator name; ambiguous addresses dropped. */
async function fetchCuratorRoster(): Promise<Map<string, string>> {
  const res = await fetch(MORPHO_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: ROSTER_QUERY }),
  });
  if (!res.ok) throw new Error(`Morpho curators query failed: ${res.status}`);
  const json: any = await res.json();
  if (json?.errors?.length) {
    throw new Error(
      `Morpho curators GraphQL error: ${json.errors.map((e: any) => e?.message).join("; ")}`,
    );
  }
  const items: any[] = json?.data?.curators?.items ?? [];
  const byAddress = new Map<string, Set<string>>();
  for (const c of items) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    for (const a of c?.addresses ?? []) {
      const addr = String(a?.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      if (!byAddress.has(addr)) byAddress.set(addr, new Set());
      byAddress.get(addr)!.add(name);
    }
  }
  const out = new Map<string, string>();
  let ambiguous = 0;
  for (const [addr, names] of byAddress) {
    if (names.size === 1) out.set(addr, [...names][0]);
    else ambiguous++;
  }
  console.log(
    `Curator roster: ${items.length} curators, ${out.size} usable addresses (${ambiguous} ambiguous dropped)`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Rung 3 — conservative curator-from-name parse. Same word lists as
// margin-fetcher's `curatorNameFromVaultName`, with one extra guard: the run
// must TERMINATE on a stop/asset token with something left over, so a name
// with no structure ("RHVault") yields nothing instead of itself.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "vault", "vaults", "savings", "yield", "exclusive", "dao", "x", "pt",
  "prime", "staked", "core", "lista", "moolah", "rwa",
]);

const ASSET_TOKENS = new Set([
  "usdc", "usdt", "usd1", "usds", "dai", "usde", "susde", "lisusd", "gho",
  "frax", "pyusd", "rusd", "usr", "rlp", "usdg", "eth", "weth", "wsteth",
  "reth", "steth", "cbeth", "weeth", "ezeth", "btc", "wbtc", "btcb", "cbbtc",
  "tbtc", "xaut", "xrp", "bnb", "wbnb", "sol", "op", "arb", "avax", "pol",
  "matic", "sei", "celo", "hype", "plume", "s",
]);

function curatorFromVaultName(
  name: string | undefined,
  assetSymbol: string | undefined,
): string | undefined {
  if (!name) return undefined;
  // A test/fake vault's leading word is not a curator, whatever the casing.
  if (/\b(test|testing|fake)\b/i.test(name)) return undefined;
  const cleaned = name.replace(/\([^)]*\)\s*$/, "").trim();
  if (!cleaned) return undefined;
  const tokens = cleaned
    .split(/[\s/]+/)
    .flatMap((t) => t.split("-"))
    .filter(Boolean);
  const asset = (assetSymbol ?? "").toLowerCase();
  const out: string[] = [];
  let terminated = false;
  for (const tok of tokens) {
    const tl = tok.toLowerCase();
    // Any usd-bearing ticker ("ctUSD", "USDm", "sUSDe") is an asset token even
    // when the explicit list and the underlying's own symbol both miss it.
    if (
      STOP_WORDS.has(tl) ||
      (asset && tl === asset) ||
      ASSET_TOKENS.has(tl) ||
      tl.includes("usd")
    ) {
      terminated = true;
      break;
    }
    out.push(tok);
    if (out.length >= 3) break;
  }
  // A run that swallowed the whole name never hit the vault-name structure —
  // it IS the vault name, not a curator.
  if (!terminated || out.length === tokens.length) return undefined;
  const curator = out.join(" ").trim();
  return curator.length >= 2 ? curator : undefined;
}

// ---------------------------------------------------------------------------
// On-chain reads — curator() + owner() per vault, symbol() per underlying.
// ---------------------------------------------------------------------------

const GOVERNANCE_ABI = parseAbi([
  "function curator() view returns (address)",
  "function owner() view returns (address)",
]);
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);

const unwrap = (r: unknown) =>
  r && typeof r === "object" && "result" in (r as any) ? (r as any).result : r;

const asAddress = (r: unknown): string | undefined => {
  const v = unwrap(r);
  return typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v)
    ? v.toLowerCase()
    : undefined;
};

async function readGovernance(
  chainId: string,
  vaults: string[],
): Promise<Map<string, { curator?: string; owner?: string }>> {
  const out = new Map<string, { curator?: string; owner?: string }>();
  if (vaults.length === 0) return out;
  const calls = vaults.flatMap((address) => [
    { address, name: "curator", args: [] },
    { address, name: "owner", args: [] },
  ]);
  const res = (await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: GOVERNANCE_ABI,
    allowFailure: true,
  })) as unknown[];
  vaults.forEach((v, i) => {
    out.set(v, {
      curator: asAddress(res[i * 2]),
      owner: asAddress(res[i * 2 + 1]),
    });
  });
  return out;
}

async function readSymbols(
  chainId: string,
  tokens: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (tokens.length === 0) return out;
  const res = (await multicallRetryUniversal({
    chain: chainId,
    calls: tokens.map((address) => ({ address, name: "symbol", args: [] })),
    abi: SYMBOL_ABI,
    allowFailure: true,
  })) as unknown[];
  tokens.forEach((t, i) => {
    const v = unwrap(res[i]);
    if (typeof v === "string" && v.trim()) out.set(t, v.trim());
  });
  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const existing: MorphoTypeVaultsByFork = readJsonFile(VAULTS_FILE);
  const byChain = existing[FORK] ?? {};

  const roster = await fetchCuratorRoster();

  let fromManual = 0;
  let fromRoster = 0;
  let fromName = 0;
  let unresolved = 0;
  const failures: string[] = [];

  const chainIds = Object.keys(byChain).filter(
    (c) => CHAIN_FILTER.size === 0 || CHAIN_FILTER.has(c),
  );

  await Promise.all(
    chainIds.map(async (chainId) => {
      const entries: MorphoTypeVault[] = byChain[chainId] ?? [];
      if (entries.length === 0) return;

      let governance = new Map<string, { curator?: string; owner?: string }>();
      let symbols = new Map<string, string>();
      try {
        const underlyings = [
          ...new Set(entries.map((e) => e.underlying.toLowerCase())),
        ];
        [governance, symbols] = await Promise.all([
          readGovernance(
            chainId,
            entries.map((e) => e.vault.toLowerCase()),
          ),
          readSymbols(chainId, underlyings),
        ]);
      } catch (err) {
        // Roster + name rungs still work without the chain; only the
        // address join degrades. Report it rather than dropping the chain.
        failures.push(chainId);
        console.warn(
          `  chain ${chainId}: on-chain reads failed: ${(err as any)?.message ?? err}`,
        );
      }

      for (const entry of entries) {
        const vault = entry.vault.toLowerCase();
        const gov = governance.get(vault) ?? {};

        const manual = MANUAL_CURATORS[chainId]?.[vault]?.trim();
        const rosterName =
          (gov.curator && roster.get(gov.curator)) ||
          (gov.owner && roster.get(gov.owner)) ||
          undefined;

        if (manual) {
          if (entry.curatorName !== manual) entry.curatorName = manual;
          fromManual++;
          continue;
        }
        if (rosterName) {
          // The roster is authoritative — it may refresh a stale stored name.
          if (entry.curatorName !== rosterName) entry.curatorName = rosterName;
          fromRoster++;
          continue;
        }
        if (entry.curatorName) continue; // keep what a human/roster once set
        const derived = curatorFromVaultName(
          entry.name,
          symbols.get(entry.underlying.toLowerCase()),
        );
        if (derived) {
          entry.curatorName = derived;
          fromName++;
        } else {
          unresolved++;
        }
      }
    }),
  );

  const writeResult = await writeTextIfChanged(
    VAULTS_FILE,
    JSON.stringify(existing, null, 2) + "\n",
  );
  console.log(
    `Curators: ${fromManual} manual, ${fromRoster} roster, ${fromName} name-derived, ${unresolved} unresolved; file ${writeResult}.`,
  );
  if (failures.length > 0) {
    console.warn(
      `Governance reads failed on ${failures.length} chain(s): ${failures.join(", ")}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
