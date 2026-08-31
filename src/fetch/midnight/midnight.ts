import { readFileSync } from "fs";
import { erc20Abi } from "viem";
import { MarketUtils } from "@morpho-org/midnight-sdk";
import { multicallRetryUniversal } from "@1delta/providers";
import { DataUpdater } from "../../types.js";
import { mergeData as deepMergeData, numberToBps } from "../../utils.js";
import { fetchTenorFixedMarkets, type TenorFixedMarket } from "./tenorApi.js";
import {
  fetchMorphoMidnightMarkets,
  type MorphoMidnightMarket,
} from "./morphoApi.js";

const MARKETS_FILE = "./data/midnight-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/midnight.json";
const DEFAULT_API = "https://api.morpho.org/v0/midnight";
const DEFAULT_TENOR_API = "https://api.tenor.finance/graphql";

/** Distinct per-market lender enum key, e.g. `MORPHO_MIDNIGHT_<HASH>` (mirrors `MORPHO_BLUE_<HASH>`). */
const midnightEnumKey = (marketId: string): string =>
  `MORPHO_MIDNIGHT_${marketId.slice(2).toUpperCase()}`;

const isoDate = (unixSecs: number): string =>
  new Date(unixSecs * 1000).toISOString().slice(0, 10);

const ZERO = "0x0000000000000000000000000000000000000000";
const isZeroAddr = (a?: string | null) => !a || a.toLowerCase() === ZERO;

// Fallback token metadata for common Base tokens, used only where the on-chain
// multicall can't resolve a token (keeps the run robust + names stable in CI).
const KNOWN_META: Record<string, { decimals: number; symbol: string }> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { decimals: 6, symbol: "USDC" },
  "0x4200000000000000000000000000000000000006": {
    decimals: 18,
    symbol: "WETH",
  },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": {
    decimals: 8,
    symbol: "cbBTC",
  },
  "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452": {
    decimals: 18,
    symbol: "wstETH",
  },
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": { decimals: 6, symbol: "EURC" },
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": {
    decimals: 18,
    symbol: "cbETH",
  },
};

type ChainCfg = {
  apiBaseUrl?: string;
  tenorApiUrl?: string;
  midnight?: string;
};

/**
 * The roster shape both sources normalize into. Everything needed to rebuild
 * the on-chain `Market` struct (and therefore to re-derive the market id), plus
 * the curation metadata each source happens to carry.
 */
type RosterMarket = TenorFixedMarket & {
  marketFamilyId?: string;
  listed?: boolean;
};

// Minimal `marketState(bytes32)` fragment — the only extra on-chain read this
// updater needs. Inlined (not imported from @1delta/abis) so the nightly job
// is robust to abis version drift. Returns the packed MarketState: the fields
// we care about are settlementFeeCbp0..6 (uint16, in cbp) and continuousFee
// (uint32, per-second WAD). These are MUTABLE governance state (set by the
// `feeSetter`), NOT part of the immutable market id — so they can't live in the
// API's payload and must be snapshotted on-chain each refresh cycle.
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

/**
 * Roster ladder: **Tenor primary → Morpho fallback**.
 *
 * Tenor is preferred because it curates — Morpho lists every permissionlessly
 * created market (187 on Base against Tenor's 36), most of them empty shells,
 * and each one costs the user-data path `2 + legs` multicall slots per account.
 * Morpho is the right thing to degrade to because it is the protocol operator's
 * own API; Tenor is a third party over the same contract.
 *
 * Both sources throw on an empty result, so "no markets" can never be mistaken
 * for an authoritative answer and silently wipe the roster.
 */
async function fetchRoster(
  chainId: string,
  cfg: ChainCfg,
): Promise<{ markets: RosterMarket[]; source: "tenor" | "morpho" }> {
  const tenorUrl = cfg.tenorApiUrl || DEFAULT_TENOR_API;
  const morphoBase = cfg.apiBaseUrl || DEFAULT_API;

  let tenor: TenorFixedMarket[] | null = null;
  try {
    const all = await fetchTenorFixedMarkets(tenorUrl);
    const forChain = all.filter((m) => String(m.chainId) === String(chainId));
    if (forChain.length > 0) tenor = forChain;
    else
      console.log(
        `Midnight: Tenor returned no markets for chain ${chainId} — falling back to Morpho`,
      );
  } catch (e) {
    console.log(
      `Midnight: Tenor roster failed (${(e as any)?.message ?? e}) — falling back to Morpho`,
    );
  }

  if (tenor) {
    // Morpho carries two fields Tenor does not publish (`market_family_id`,
    // `listed`). Enrich BEST-EFFORT: a Morpho outage must cost us those optional
    // fields, never the roster, or the "fallback" would be a hard dependency in
    // disguise.
    let byId = new Map<string, MorphoMidnightMarket>();
    try {
      const morpho = await fetchMorphoMidnightMarkets(morphoBase, chainId);
      byId = new Map(morpho.map((m) => [m.marketId.toLowerCase(), m]));
    } catch (e) {
      console.log(
        `Midnight: Morpho enrichment unavailable (${(e as any)?.message ?? e}) — marketFamilyId/listed omitted`,
      );
    }
    const markets: RosterMarket[] = tenor.map((m) => {
      const extra = byId.get(m.marketId.toLowerCase());
      return {
        ...m,
        marketFamilyId: extra?.marketFamilyId,
        listed: extra?.listed,
        // Prefer Morpho's units when present: it is the protocol's own view.
        totalUnits: extra?.totalUnits ?? m.totalUnits,
      };
    });
    return { markets, source: "tenor" };
  }

  const morpho = await fetchMorphoMidnightMarkets(morphoBase, chainId);
  return {
    markets: morpho.map((m) => ({
      marketId: m.marketId,
      chainId: m.chainId,
      loanToken: m.loanToken,
      collaterals: m.collaterals,
      maturity: m.maturity,
      rcfThreshold: m.rcfThreshold,
      enterGate: m.enterGate,
      liquidatorGate: m.liquidatorGate,
      settlementFeeCbp: m.settlementFeeCbp,
      continuousFee: m.continuousFee,
      marketFamilyId: m.marketFamilyId,
      listed: m.listed,
      totalUnits: m.totalUnits,
      // Morpho knows nothing about Tenor's series, deprecation or vault join.
      seriesId: undefined,
      deprecatedAt: null,
      collateralVault: null,
    })),
    source: "morpho",
  };
}

/**
 * Re-derive each market's id from its own struct and drop any that disagrees.
 *
 * The market id IS the hash of `{chainId, midnight, loanToken, collateralParams,
 * maturity, rcfThreshold, enterGate, liquidatorGate}`, so a struct validates
 * ITSELF — no second API and no trust in either one. A struct wrong in any field
 * produces takes that revert with nothing to point at, and a diff against a
 * second source would only catch DISAGREEMENT, staying silent when both sources
 * are wrong the same way.
 *
 * Verified 16/16 against live data (6 configured markets + 10 multi-collateral),
 * including one market whose legs arrive in the reverse LLTV order — leg order
 * is part of the hash, which is why nothing here sorts or dedupes.
 */
function verifyMarketIds(
  chainId: string,
  midnight: string,
  markets: RosterMarket[],
): RosterMarket[] {
  const kept: RosterMarket[] = [];
  for (const m of markets) {
    let derived: string | undefined;
    try {
      derived = MarketUtils.toId({
        chainId: BigInt(chainId),
        midnight: midnight as `0x${string}`,
        loanToken: m.loanToken as `0x${string}`,
        collateralParams: m.collaterals.map((c) => ({
          token: c.token as `0x${string}`,
          lltv: BigInt(c.lltv),
          liquidationCursor: BigInt(c.liquidationCursor),
          oracle: c.oracle as `0x${string}`,
        })),
        maturity: BigInt(m.maturity),
        rcfThreshold: BigInt(m.rcfThreshold),
        enterGate: (m.enterGate ?? ZERO) as `0x${string}`,
        liquidatorGate: (m.liquidatorGate ?? ZERO) as `0x${string}`,
      } as any) as string;
    } catch (e) {
      console.log(
        `Midnight: market ${m.marketId} id derivation threw (${(e as any)?.message ?? e}) — DROPPED`,
      );
      continue;
    }
    if (derived.toLowerCase() !== m.marketId.toLowerCase()) {
      console.log(
        `Midnight: market ${m.marketId} struct hashes to ${derived} — DROPPED (source served a bad struct)`,
      );
      continue;
    }
    kept.push(m);
  }
  return kept;
}

/**
 * Curate the roster.
 *
 * Keep a market when it is unmatured, OR when it still holds units. The second
 * clause is the important one and it is the offboarded-but-nonempty rule used
 * for Sky ilks: a matured or deprecated market is not a dead market — positions
 * settle, get repaid, exited and liquidated after maturity, and a deprecated
 * SERIES held ~$239k of live positions when this was written. Dropping those
 * would recreate exactly the bug this rewrite fixes: a user's position reading
 * as nothing because the market was not in the roster.
 *
 * Only a market that is both closed AND empty has nothing left to read.
 */
export function curate(
  markets: RosterMarket[],
  nowSec: number,
): { kept: RosterMarket[]; dropped: number } {
  const kept = markets.filter((m) => {
    if (Number(m.maturity) > nowSec) return true;
    return BigInt(m.totalUnits ?? "0") > 0n;
  });
  return { kept, dropped: markets.length - kept.length };
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
 * read reverts falls back to whatever the API reported, so the run never breaks
 * on an RPC blip. Returns a map keyed by lowercased marketId.
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

/**
 * Classify a market's gates.
 *
 * `'unknown'` is a REAL value, not a placeholder: a gate contract we do not
 * recognise is not an open market, and callers gate on `enter === 'open'` rather
 * than on the address being zero, so an unrecognised gate refuses new positions
 * instead of emitting calldata that reverts. Recognising the specific Tenor gate
 * kinds (`MidnightAllowlistGate`, `DelayedLiquidationGate` — both factory-cloned
 * per market, so it needs a clone check) is P3, not this phase.
 */
export function classifyGating(enterGate?: string, liquidatorGate?: string) {
  return {
    enter: isZeroAddr(enterGate) ? ("open" as const) : ("unknown" as const),
    liquidator: isZeroAddr(liquidatorGate)
      ? ("open" as const)
      : ("unknown" as const),
    enterGate: enterGate ?? ZERO,
    liquidatorGate: liquidatorGate ?? ZERO,
  };
}

/**
 * Short label for one collateral leg.
 *
 * A Vault-V2 wrapper listed as collateral carries a symbol like
 * `cbBTC-USDC-collat`, which is both long and misleading in a market name (it
 * names the PAIR, not the asset). Since the wrapper always holds the loan token,
 * `v<loanSymbol>` says exactly what it is and keeps the name readable.
 */
function legLabel(
  token: string,
  loanSymbol: string | undefined,
  collateralVault: string | null | undefined,
  sym: (a: string) => string,
): string {
  if (
    collateralVault &&
    token.toLowerCase() === collateralVault.toLowerCase() &&
    loanSymbol
  ) {
    return `v${loanSymbol}`;
  }
  return sym(token);
}

/**
 * Morpho Midnight is a fixed-rate, fixed-maturity order-book protocol. Markets
 * EXPIRE and roll on a cadence, so this updater rebuilds the live market set per
 * chain on every run.
 *
 * Source ladder is **Tenor primary → Morpho fallback** (see `fetchRoster`), every
 * market id is re-derived from its own struct before it is written (see
 * `verifyMarketIds`), and curation keeps anything unmatured or still holding
 * units (see `curate`). Output → `data/midnight-markets.json`, shape
 * `{ [chainId]: MidnightMarketConfig[] }` (consumed by data-sdk's
 * `midnightMarkets` registry). Deployment addresses live in the static
 * `config/midnight.json` and drive which chains/APIs this fetches.
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

    const result: Record<string, any[]> = {};
    // Human-readable labels keyed by the distinct `MORPHO_MIDNIGHT_<id>` enum,
    // written to data/lender-labels.json exactly like Morpho Blue / Lista. The
    // maturity date is part of the name so same-pair markets at different
    // maturities stay distinct, and EVERY leg's symbol and LLTV appear so two
    // markets differing only in a second leg cannot render identically.
    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};
    const nowSec = Math.floor(Date.now() / 1000);

    for (const chainId of chainIds) {
      const midnight = config[chainId]?.midnight;
      if (!midnight) {
        console.log(
          `Midnight: chain ${chainId} has no core address in config — skipping`,
        );
        result[chainId] = [];
        continue;
      }

      let roster: RosterMarket[];
      let source: "tenor" | "morpho";
      try {
        const fetched = await fetchRoster(chainId, config[chainId]);
        roster = fetched.markets;
        source = fetched.source;
      } catch (e) {
        // Both rungs failed. Emit an empty list; `mergeData` keeps the previous
        // file rather than wiping a chain on a transient outage.
        console.log(
          `Midnight: chain ${chainId}: roster unavailable from both sources (${(e as any)?.message ?? e}) — keeping previous data`,
        );
        result[chainId] = [];
        continue;
      }

      const verified = verifyMarketIds(chainId, midnight, roster);
      const { kept, dropped } = curate(verified, nowSec);
      console.log(
        `Midnight: chain ${chainId}: ${kept.length} markets from ${source} ` +
          `(${roster.length} fetched, ${roster.length - verified.length} failed id check, ` +
          `${dropped} dropped as matured+empty)`,
      );
      if (kept.length === 0) {
        result[chainId] = [];
        continue;
      }

      const tokens = new Set<string>();
      for (const m of kept) {
        tokens.add(m.loanToken.toLowerCase());
        for (const c of m.collaterals) tokens.add(c.token.toLowerCase());
      }
      const meta = await resolveTokenMeta(chainId, [...tokens]);
      const fees = await resolveMarketFees(
        chainId,
        midnight,
        kept.map((m) => m.marketId),
      );

      const dec = (a: string) =>
        meta[a.toLowerCase()]?.decimals ??
        KNOWN_META[a.toLowerCase()]?.decimals ??
        18;
      const sym = (a: string) =>
        meta[a.toLowerCase()]?.symbol ??
        KNOWN_META[a.toLowerCase()]?.symbol ??
        a.slice(0, 6);

      const markets = kept
        .slice()
        .sort((a, b) => (a.marketId < b.marketId ? -1 : 1))
        .map((m) => {
          const key = midnightEnumKey(m.marketId);
          const loanSym = sym(m.loanToken);
          const date = isoDate(Number(m.maturity));

          // EVERY leg, in on-chain order, with EVERY leg's LLTV. The old label
          // joined all the symbols but carried only leg 0's LLTV, so a two-leg
          // market advertised one number for two different thresholds.
          const legSyms = m.collaterals.map((c) =>
            legLabel(c.token, loanSym, m.collateralVault, sym),
          );
          const legBps = m.collaterals.map((c) => numberToBps(String(c.lltv)));
          const collLabel = legSyms.join("+") || "?";
          const bpsLabel = legBps.join("/");

          names[key] = `Midnight ${collLabel}-${loanSym} ${bpsLabel} ${date}`
            .replace(/\s+/g, " ")
            .trim();
          shortNames[key] = `MN ${collLabel}-${loanSym} ${bpsLabel} ${date}`
            .replace(/\s+/g, " ")
            .trim();

          const entry: any = {
            marketId: m.marketId,
            loanToken: m.loanToken,
            loanDecimals: dec(m.loanToken),
            collateralParams: m.collaterals.map((c) => {
              const leg: any = {
                token: c.token,
                lltv: c.lltv,
                liquidationCursor: c.liquidationCursor,
                oracle: c.oracle,
                decimals: dec(c.token),
              };
              // Mark the ERC-4626 wrapper leg so consumers know entering it is a
              // wrap-then-supply, not a plain transfer, and that the collateral
              // is itself a lending position.
              if (
                m.collateralVault &&
                c.token.toLowerCase() === m.collateralVault.toLowerCase()
              ) {
                leg.collateralVault = m.collateralVault;
              }
              return leg;
            }),
            maturity: m.maturity,
            rcfThreshold: m.rcfThreshold,
            enterGate: m.enterGate ?? ZERO,
            liquidatorGate: m.liquidatorGate ?? ZERO,
            gating: classifyGating(m.enterGate, m.liquidatorGate),
          };

          // On-chain snapshot is authoritative for the mutable fees; the API's
          // copy is the fallback when the read reverted.
          const f = fees[m.marketId.toLowerCase()];
          if (f) {
            entry.settlementFeeCbp = f.settlementFeeCbp;
            entry.continuousFee = f.continuousFee;
          } else {
            if (m.settlementFeeCbp) entry.settlementFeeCbp = m.settlementFeeCbp;
            if (m.continuousFee !== undefined)
              entry.continuousFee = m.continuousFee;
          }

          if (m.marketFamilyId) entry.marketFamilyId = m.marketFamilyId;
          if (m.seriesId) entry.tenorSeriesId = m.seriesId;
          if (typeof m.listed === "boolean") entry.listed = m.listed;
          if (m.deprecatedAt) entry.deprecatedAt = m.deprecatedAt;

          entry.name = `${collLabel}/${loanSym} - ${date}`;
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
