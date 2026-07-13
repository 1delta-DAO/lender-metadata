import { readFileSync } from "fs";
import { erc20Abi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { DataUpdater } from "../../types.js";

const MARKETS_FILE = "./data/midnight-markets.json";
const CONFIG_FILE = "./config/midnight.json";
const DEFAULT_API = "https://api.morpho.org/v0/midnight";

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
      const dec = (a: string) =>
        meta[a.toLowerCase()]?.decimals ??
        KNOWN_META[a.toLowerCase()]?.decimals ??
        18;

      const markets = chainBooks
        .sort((a, b) => (a.market_id < b.market_id ? -1 : 1))
        .map((b) => {
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
          const nm = marketName(b, meta);
          if (nm) entry.name = nm;
          return entry;
        });

      console.log(`Midnight: chain ${chainId}: ${markets.length} markets`);
      result[chainId] = markets;
    }

    return { [MARKETS_FILE]: result };
  }

  /**
   * Replace each chain's market list with the freshly-fetched live set (markets
   * expire, so append-only would accumulate stale entries). Guard: if a fetch
   * returned an empty set for a chain that previously had markets, keep the old
   * data rather than wiping it on a transient API failure.
   */
  mergeData(oldData: any, data: any): any {
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
