import { readFileSync } from "fs";
import { erc20Abi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { DataUpdater } from "../../types.js";
import { mergeData as deepMergeData, numberToBps } from "../../utils.js";

const MARKETS_FILE = "./data/midnight-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/midnight.json";
const DEFAULT_API = "https://api.morpho.org/v0/midnight";

/** Distinct per-market lender enum key, e.g. `MORPHO_MIDNIGHT_<HASH>` (mirrors `MORPHO_BLUE_<HASH>`). */
const midnightEnumKey = (marketId: string): string =>
  `MORPHO_MIDNIGHT_${marketId.slice(2).toUpperCase()}`;

const isoDate = (unixSecs: number): string =>
  new Date(unixSecs * 1000).toISOString().slice(0, 10);

// Fallback token metadata for common Base tokens, used only where the on-chain
// multicall can't resolve a token (keeps the run robust + names stable in CI).
const KNOWN_META: Record<string, { decimals: number; symbol: string }> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { decimals: 6, symbol: "USDC" },
  "0x4200000000000000000000000000000000000006": { decimals: 18, symbol: "WETH" },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { decimals: 8, symbol: "cbBTC" },
  "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452": { decimals: 18, symbol: "wstETH" },
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": { decimals: 6, symbol: "EURC" },
};

type ChainCfg = { apiBaseUrl?: string; midnight?: string };

// Minimal `marketState(bytes32)` fragment — the only extra on-chain read this
// updater needs. Inlined (not imported from @1delta/abis) so the nightly job
// is robust to abis version drift. Returns the packed MarketState: the fields
// we care about are settlementFeeCbp0..6 (uint16, in cbp) and continuousFee
// (uint32, per-second WAD). These are MUTABLE governance state (set by the
// `feeSetter`), NOT part of the immutable market id — so they can't live in the
// API's book payload and must be snapshotted on-chain each refresh cycle.
const MARKET_STATE_ABI = [
  {
    type: "function",
    name: "marketState",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalUnits", type: "uint128" },
      { name: "lossFactor", type: "uint128" },
      { name: "withdrawable", type: "uint128" },
      { name: "continuousFeeCredit", type: "uint128" },
      { name: "settlementFeeCbp0", type: "uint16" },
      { name: "settlementFeeCbp1", type: "uint16" },
      { name: "settlementFeeCbp2", type: "uint16" },
      { name: "settlementFeeCbp3", type: "uint16" },
      { name: "settlementFeeCbp4", type: "uint16" },
      { name: "settlementFeeCbp5", type: "uint16" },
      { name: "settlementFeeCbp6", type: "uint16" },
      { name: "continuousFee", type: "uint32" },
      { name: "tickSpacing", type: "uint8" },
    ],
  },
] as const;

/** Snapshotted mutable per-market fees, keyed by lowercased marketId. */
type MarketFees = { settlementFeeCbp: number[]; continuousFee: string };

function readConfig(): Record<string, ChainCfg> {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Paginate the Midnight API book list (all chains; caller filters by chain_id). */
async function fetchAllBooks(apiBase: string): Promise<any[]> {
  const base = apiBase.replace(/\/+$/, "");
  const out: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const url = `${base}/books?limit=20${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Midnight books HTTP ${res.status}`);
    const json: any = await res.json();
    for (const b of json?.data ?? []) out.push(b);
    cursor = json?.cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

/** Resolve decimals + symbol for a set of tokens via a single multicall. */
async function resolveTokenMeta(
  chainId: string,
  tokens: string[],
): Promise<Record<string, { decimals: number; symbol?: string }>> {
  const out: Record<string, { decimals: number; symbol?: string }> = {};
  if (tokens.length === 0) return out;

  const calls = tokens.flatMap((t) => [
    { address: t, name: "decimals", args: [] },
    { address: t, name: "symbol", args: [] },
  ]);

  let res: any[] = [];
  try {
    res = (await multicallRetryUniversal({
      chain: chainId,
      calls,
      abi: erc20Abi as any,
      allowFailure: true,
    })) as any[];
  } catch (e) {
    console.log(
      `Midnight: decimals multicall failed on chain ${chainId}:`,
      (e as any)?.shortMessage ?? (e as any)?.message ?? e,
    );
  }

  tokens.forEach((t, i) => {
    const key = t.toLowerCase();
    const dRaw = res[i * 2];
    const sRaw = res[i * 2 + 1];
    const known = KNOWN_META[key];
    const decimals =
      typeof dRaw === "bigint" || typeof dRaw === "number"
        ? Number(dRaw)
        : (known?.decimals ?? 18);
    const symbol =
      typeof sRaw === "string" && sRaw.length > 0 ? sRaw : known?.symbol;
    out[key] = { decimals, symbol };
  });
  return out;
}

/**
 * Snapshot the MUTABLE per-market fees (`settlementFeeCbp[0..6]`,
 * `continuousFee`) via a single `marketState` multicall against the core
 * Midnight contract. Failures are tolerated (allowFailure) — a market whose
 * read reverts simply carries no fee fields, so the run never breaks on an RPC
 * blip. Returns a map keyed by lowercased marketId.
 */
async function resolveMarketFees(
  chainId: string,
  midnight: string,
  marketIds: string[],
): Promise<Record<string, MarketFees>> {
  const out: Record<string, MarketFees> = {};
  if (marketIds.length === 0) return out;

  const calls = marketIds.map((id) => ({
    address: midnight,
    name: "marketState",
    args: [id],
  }));

  let res: any[] = [];
  try {
    res = (await multicallRetryUniversal({
      chain: chainId,
      calls,
      abi: MARKET_STATE_ABI as any,
      allowFailure: true,
    })) as any[];
  } catch (e) {
    console.log(
      `Midnight: marketState multicall failed on chain ${chainId}:`,
      (e as any)?.shortMessage ?? (e as any)?.message ?? e,
    );
    return out;
  }

  marketIds.forEach((id, i) => {
    const r = res[i];
    // `marketState` has 13 named outputs → viem returns them as a positional
    // array: [totalUnits, lossFactor, withdrawable, continuousFeeCredit,
    //  settlementFeeCbp0..6, continuousFee, tickSpacing].
    if (!Array.isArray(r) || r.length < 13) return;
    const num = (v: any) => (v == null ? 0 : Number(v));
    const settlementFeeCbp = [4, 5, 6, 7, 8, 9, 10].map((idx) => num(r[idx]));
    out[id.toLowerCase()] = {
      settlementFeeCbp,
      continuousFee: (r[11] ?? 0n).toString(),
    };
  });
  return out;
}

function marketName(
  book: any,
  meta: Record<string, { decimals: number; symbol?: string }>,
): string | undefined {
  const ls = meta[book.loan_token?.toLowerCase()]?.symbol;
  const cs = book.collaterals?.[0]
    ? meta[book.collaterals[0].token?.toLowerCase()]?.symbol
    : undefined;
  if (!ls || !cs) return undefined;
  const d = new Date(Number(book.maturity) * 1000).toISOString().slice(0, 10);
  return `${cs}/${ls} - ${d}`;
}

/**
 * Morpho Midnight is a fixed-rate, fixed-maturity order-book protocol. Markets
 * are created permissionlessly and EXPIRE, so this updater rebuilds the current
 * live market set per chain from the Midnight API (`GET /books`) each run,
 * resolving token decimals on-chain. Output → `data/midnight-markets.json`,
 * shape `{ [chainId]: MidnightMarketConfig[] }` (consumed by data-sdk's
 * `midnightMarkets` registry). Deployment addresses live in the static
 * `config/midnight.json` and drive which chains/API this fetches.
 */
export class MidnightUpdater implements DataUpdater {
  name = "Morpho Midnight Markets";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    const config = readConfig();
    const chainIds = Object.keys(config);
    if (chainIds.length === 0) {
      console.log("Midnight: no chains in config/midnight.json, skipping");
      return { [MARKETS_FILE]: {} };
    }

    // The API isn't chain-filterable, so fetch once per distinct API base.
    const byApi = new Map<string, any[]>();
    const result: Record<string, any[]> = {};
    // Human-readable labels keyed by the distinct `MORPHO_MIDNIGHT_<id>` enum,
    // written to data/lender-labels.json exactly like Morpho Blue / Lista. The
    // maturity date is part of the name so same-pair markets at different
    // maturities stay distinct.
    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};

    for (const chainId of chainIds) {
      const apiBase = config[chainId]?.apiBaseUrl || DEFAULT_API;
      let books = byApi.get(apiBase);
      if (!books) {
        try {
          books = await fetchAllBooks(apiBase);
        } catch (e) {
          console.log(
            `Midnight: book fetch failed (${apiBase}):`,
            (e as any)?.message ?? e,
          );
          books = [];
        }
        byApi.set(apiBase, books);
      }

      const chainBooks = books.filter(
        (b) => String(b.chain_id) === String(chainId),
      );
      if (chainBooks.length === 0) {
        console.log(`Midnight: chain ${chainId}: 0 markets from API`);
        result[chainId] = [];
        continue;
      }

      const tokens = new Set<string>();
      for (const b of chainBooks) {
        tokens.add(b.loan_token.toLowerCase());
        for (const c of b.collaterals ?? []) tokens.add(c.token.toLowerCase());
      }
      const meta = await resolveTokenMeta(chainId, [...tokens]);
      // Snapshot mutable fees on-chain (needs the core address from config).
      const midnight = config[chainId]?.midnight;
      const fees = midnight
        ? await resolveMarketFees(
            chainId,
            midnight,
            chainBooks.map((b) => b.market_id),
          )
        : {};
      const dec = (a: string) =>
        meta[a.toLowerCase()]?.decimals ??
        KNOWN_META[a.toLowerCase()]?.decimals ??
        18;
      const sym = (a: string) =>
        meta[a.toLowerCase()]?.symbol ??
        KNOWN_META[a.toLowerCase()]?.symbol ??
        a.slice(0, 6);

      const markets = chainBooks
        .sort((a, b) => (a.market_id < b.market_id ? -1 : 1))
        .map((b) => {
          // Blue-style label + maturity: "Midnight cbBTC-USDC 92 2026-07-31".
          const key = midnightEnumKey(b.market_id);
          const loanSym = sym(b.loan_token);
          const collSym =
            (b.collaterals ?? []).map((c: any) => sym(c.token)).join("/") || "?";
          const bps = b.collaterals?.[0]
            ? numberToBps(String(b.collaterals[0].lltv))
            : "";
          const date = isoDate(Number(b.maturity));
          names[key] = `Midnight ${collSym}-${loanSym} ${bps} ${date}`
            .replace(/\s+/g, " ")
            .trim();
          // Include the LLTV so same-pair/same-maturity markets at different
          // LLTVs stay distinct (mirrors Blue's `MB <pair> <bps>`).
          shortNames[key] = `MN ${collSym}-${loanSym} ${bps} ${date}`
            .replace(/\s+/g, " ")
            .trim();

          const entry: any = {
            marketId: b.market_id,
            loanToken: b.loan_token,
            loanDecimals: dec(b.loan_token),
            collateralParams: (b.collaterals ?? []).map((c: any) => ({
              token: c.token,
              lltv: String(c.lltv),
              liquidationCursor: String(c.liquidation_cursor),
              oracle: c.oracle,
              decimals: dec(c.token),
            })),
            maturity: String(b.maturity),
            rcfThreshold: String(b.rcf_threshold),
            enterGate: b.enter_gate,
            liquidatorGate: b.liquidator_gate,
          };
          // Mutable, on-chain-snapshotted fees (omitted if the read reverted).
          const f = fees[b.market_id?.toLowerCase()];
          if (f) {
            entry.settlementFeeCbp = f.settlementFeeCbp;
            entry.continuousFee = f.continuousFee;
          }
          const nm = marketName(b, meta);
          if (nm) entry.name = nm;
          return entry;
        });

      console.log(`Midnight: chain ${chainId}: ${markets.length} markets`);
      result[chainId] = markets;
    }

    return {
      [MARKETS_FILE]: result,
      [LABELS_FILE]: { names, shortNames },
    };
  }

  /**
   * - Markets file: replace each chain's market list with the freshly-fetched
   *   live set (markets expire, so append-only would accumulate stale entries).
   *   Guard: if a fetch returned an empty set for a chain that previously had
   *   markets, keep the old data rather than wiping it on a transient API blip.
   * - Labels file: deep-merge (accumulate) — shared across every lender family,
   *   so it must never be replaced; matches the Morpho Blue updater.
   */
  mergeData(oldData: any, data: any, fileKey: string): any {
    if (fileKey === LABELS_FILE) {
      return deepMergeData(oldData ?? {}, data ?? {});
    }
    const merged: Record<string, any[]> = { ...(oldData ?? {}) };
    for (const [chainId, markets] of Object.entries(
      (data ?? {}) as Record<string, any[]>,
    )) {
      if (Array.isArray(markets) && markets.length > 0) {
        merged[chainId] = markets;
      } else if (!merged[chainId]) {
        merged[chainId] = [];
      }
    }
    return merged;
  }
}
