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
  /** The fee fields came from Morpho's API (authoritative; chain read = fallback). */
  apiFees?: boolean;
  /** Tenor curates this market. */
  inTenor?: boolean;
  /** Morpho's API knows this market. */
  inMorpho?: boolean;
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
 * Does a Morpho-listed market belong in the roster? (MIDNIGHT_UNIVERSE_PLAN.md
 * §3.1.) Keep it when any of these holds:
 *  - it is unmatured AND has someone to trade with (`lend_depth` or
 *    `borrow_depth` > 0);
 *  - it holds units — someone has a position, matured or not (the
 *    offboarded-but-nonempty rule);
 *  - Tenor curates it.
 * Everything else is one of the ~1,900 permissionlessly-created empty shells:
 * nothing to show and nothing to read, but `2 + legs` user-read slots each.
 * `listed` is carried, never filtered on — 114 kept markets are unlisted
 * precisely because they hold units.
 */
export function keepUniverseMarket(
  m: Pick<
    MorphoMidnightMarket,
    "maturity" | "totalUnits" | "lendDepth" | "borrowDepth"
  >,
  inTenor: boolean,
  nowSec: number,
): boolean {
  if (inTenor) return true;
  let units = 0n;
  try {
    units = BigInt(m.totalUnits ?? "0");
  } catch {}
  if (units > 0n) return true;
  return (
    Number(m.maturity) > nowSec && (m.lendDepth > 0n || m.borrowDepth > 0n)
  );
}

/**
 * Roster: **Morpho for the universe, Tenor for enrichment** (it was "Tenor,
 * else Morpho" until the plan above: the curated 86 markets missed 211 of the
 * 226 books with money in them).
 *
 * Morpho's `/markets` is every market on the chain with live depth, positions,
 * `listed` and fees; `keepUniverseMarket` cuts it to the ones worth carrying.
 * Tenor adds its series id, deprecation and vault join to those, and any market
 * it curates that Morpho does not list rides along (`tenorOnly` — checked
 * on-chain by the caller, since most are maturities never created).
 *
 * Either source alone still yields a roster: Tenor-only is the old curated
 * list, Morpho-only loses the Tenor metadata. `universe` says whether Morpho
 * answered, which decides how hard the caller may retire missing markets.
 * Both failing throws, so "no markets" is never mistaken for an answer.
 */
async function fetchRoster(
  chainId: string,
  cfg: ChainCfg,
  nowSec: number,
): Promise<{
  markets: RosterMarket[];
  source: string;
  universe: boolean;
  tenorOnly: Set<string>;
}> {
  const tenorUrl = cfg.tenorApiUrl || DEFAULT_TENOR_API;
  const morphoBase = cfg.apiBaseUrl || DEFAULT_API;

  const [tenorRes, morphoRes] = await Promise.allSettled([
    fetchTenorFixedMarkets(tenorUrl),
    fetchMorphoMidnightMarkets(morphoBase, chainId),
  ]);

  let tenor: TenorFixedMarket[] = [];
  if (tenorRes.status === "fulfilled")
    tenor = tenorRes.value.filter((m) => String(m.chainId) === String(chainId));
  else
    console.log(
      `Midnight: Tenor roster failed (${(tenorRes.reason as any)?.message ?? tenorRes.reason}) — Tenor metadata omitted`,
    );
  const morpho = morphoRes.status === "fulfilled" ? morphoRes.value : null;
  if (!morpho)
    console.log(
      `Midnight: Morpho universe failed on chain ${chainId} (${(morphoRes as any).reason?.message ?? (morphoRes as any).reason}) — Tenor roster only`,
    );
  if (!morpho && tenor.length === 0)
    throw new Error(
      `no Midnight roster for chain ${chainId} from either source`,
    );

  const tenorById = new Map(tenor.map((t) => [t.marketId.toLowerCase(), t]));
  const markets: RosterMarket[] = [];
  const seen = new Set<string>();
  let shells = 0;

  for (const m of morpho ?? []) {
    const id = m.marketId.toLowerCase();
    const t = tenorById.get(id);
    if (!keepUniverseMarket(m, !!t, nowSec)) {
      shells++;
      continue;
    }
    seen.add(id);
    markets.push({
      marketId: m.marketId,
      chainId: m.chainId,
      loanToken: m.loanToken,
      collaterals: m.collaterals,
      maturity: m.maturity,
      rcfThreshold: m.rcfThreshold,
      enterGate: m.enterGate,
      liquidatorGate: m.liquidatorGate,
      settlementFeeCbp: m.settlementFeeCbp ?? t?.settlementFeeCbp,
      continuousFee: m.continuousFee ?? t?.continuousFee,
      apiFees:
        m.settlementFeeCbp !== undefined && m.continuousFee !== undefined,
      marketFamilyId: m.marketFamilyId,
      listed: m.listed,
      totalUnits: m.totalUnits ?? t?.totalUnits,
      seriesId: t?.seriesId,
      deprecatedAt: t?.deprecatedAt ?? null,
      collateralVault: t?.collateralVault ?? null,
      inTenor: !!t,
      inMorpho: true,
    });
  }

  // Tenor-curated markets Morpho does not list (all of them, when Morpho is down).
  const tenorOnly = new Set<string>();
  for (const t of tenor) {
    const id = t.marketId.toLowerCase();
    if (seen.has(id)) continue;
    markets.push({ ...t, inTenor: true, inMorpho: false });
    if (morpho) tenorOnly.add(id);
  }
  if (tenorOnly.size > 0)
    console.log(
      `Midnight: chain ${chainId}: ${tenorOnly.size} Tenor markets unknown to Morpho's API: ${[...tenorOnly].join(", ")}`,
    );
  if (morpho)
    console.log(
      `Midnight: chain ${chainId}: Morpho universe ${morpho.length} markets, ${shells} empty shells skipped`,
    );

  const source =
    morpho && tenor.length > 0 ? "morpho+tenor" : morpho ? "morpho" : "tenor";
  return { markets, source, universe: !!morpho, tenorOnly };
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

/**
 * Roster-level counterpart of `curate()`'s offboarded-but-nonempty rule.
 *
 * `curate()` can only protect markets the source still SERVES. On 2026-09-07
 * Tenor silently removed two unmatured markets that still held units on-chain
 * (cbBTC/USDC and cbETH+vWETH/WETH, both maturing 2027-01-29), and the
 * per-chain replace in `mergeData` published the loss: live positions reading
 * as nothing. So a previously-published market may leave the file only by the
 * curate() rule — matured AND verified empty on-chain — never merely because
 * an API stopped listing it. An unreadable `totalUnits` (RPC blip) carries the
 * market forward too: deletion needs proof, retention does not.
 */
export function selectCarryForward(
  missing: any[],
  unitsById: Record<string, bigint>,
  nowSec: number,
  /**
   * Morpho's universe answered this run. Then an unmatured market missing from
   * the roster was cut for having no book, and if it is ALSO proven empty
   * on-chain there is nothing left to read — it may go. Without the universe
   * (Morpho down, Tenor-only roster) "missing" means only "not curated", so the
   * strict rule holds: matured AND proven empty.
   */
  universe = false,
): { carried: any[]; retired: any[] } {
  const carried: any[] = [];
  const retired: any[] = [];
  for (const e of missing) {
    const units = unitsById[e.marketId.toLowerCase()];
    const matured = Number(e.maturity) <= nowSec;
    if ((matured || universe) && units === 0n) retired.push(e);
    else carried.push(e);
  }
  return { carried, retired };
}

/**
 * Rebuild a `RosterMarket` from a previously-published file entry, so a
 * carried-forward market rides the normal pipeline: id re-verification,
 * on-chain fee/meta refresh, label regeneration.
 */
function rosterFromStoredEntry(
  chainId: string,
  e: any,
  totalUnits?: bigint,
): RosterMarket {
  const vaultLeg = (e.collateralParams ?? []).find(
    (c: any) => c.collateralVault,
  );
  return {
    marketId: e.marketId,
    chainId,
    loanToken: e.loanToken,
    collaterals: (e.collateralParams ?? []).map((c: any) => ({
      token: c.token,
      oracle: c.oracle,
      lltv: String(c.lltv),
      liquidationCursor: String(c.liquidationCursor),
    })),
    maturity: String(e.maturity),
    rcfThreshold: String(e.rcfThreshold),
    enterGate: e.enterGate,
    liquidatorGate: e.liquidatorGate,
    settlementFeeCbp: e.settlementFeeCbp,
    continuousFee: e.continuousFee,
    seriesId: e.tenorSeriesId,
    deprecatedAt: e.deprecatedAt ?? null,
    collateralVault: vaultLeg?.collateralVault ?? null,
    totalUnits: totalUnits?.toString(),
    marketFamilyId: e.marketFamilyId,
    listed: e.listed,
  };
}

/**
 * Read `marketState(id).totalUnits` for a set of markets. A missing key in the
 * result means the read failed — callers must treat that as "unknown", not
 * as zero.
 */
async function resolveTotalUnits(
  chainId: string,
  midnight: string,
  marketIds: string[],
): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  if (marketIds.length === 0) return out;
  let res: any[] = [];
  try {
    res = (await multicallRetryUniversal({
      chain: chainId,
      calls: marketIds.map((id) => ({
        address: midnight,
        name: "marketState",
        args: [id],
      })),
      abi: MARKET_STATE_ABI as any,
      allowFailure: true,
    })) as any[];
  } catch (e) {
    console.log(
      `Midnight: totalUnits multicall failed on chain ${chainId}:`,
      (e as any)?.shortMessage ?? (e as any)?.message ?? e,
    );
    return out;
  }
  marketIds.forEach((id, i) => {
    const r = res[i];
    if (Array.isArray(r) && r.length >= 1 && r[0] != null)
      out[id.toLowerCase()] = BigInt(r[0]);
  });
  return out;
}

/**
 * Which markets exist on-chain. A Midnight market is CREATED (`touchMarket`, or
 * its first take) — before that `marketState(id)` is all zeros, `tickSpacing`
 * included, and every action reverts `MarketNotCreated`. A created market has
 * a non-zero tick spacing. Checked 2026-10-20 on the 28 Tenor markets Morpho's
 * API does not list: every one read all-zero, i.e. maturities Tenor registered
 * that nobody ever opened (MIDNIGHT_UNIVERSE_PLAN.md Q1).
 *
 * A missing key = the read failed = unknown, never "not created".
 */
async function resolveMarketCreated(
  chainId: string,
  midnight: string,
  marketIds: string[],
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  if (marketIds.length === 0) return out;
  let res: any[] = [];
  try {
    res = (await multicallRetryUniversal({
      chain: chainId,
      calls: marketIds.map((id) => ({
        address: midnight,
        name: "marketState",
        args: [id],
      })),
      abi: MARKET_STATE_ABI as any,
      allowFailure: true,
    })) as any[];
  } catch (e) {
    console.log(
      `Midnight: marketState (created) multicall failed on chain ${chainId}:`,
      (e as any)?.shortMessage ?? (e as any)?.message ?? e,
    );
    return out;
  }
  marketIds.forEach((id, i) => {
    const r = res[i];
    if (Array.isArray(r) && r.length >= 13)
      out[id.toLowerCase()] =
        Number(r[12] ?? 0) !== 0 || BigInt(r[0] ?? 0) > 0n;
  });
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

type LabelRow = {
  key: string;
  chainId: string;
  market: RosterMarket;
  /** `<legs>-<loan> <lltvs> <date>` — what every label is built on. */
  base: string;
  entry: any;
};

const CHAIN_SHORT: Record<string, string> = {
  "1": "Ethereum",
  "8453": "Base",
  "4663": "Robinhood",
  "5042": "Arc",
};
const short = (a?: string | null) => (a ? a.slice(2, 8).toLowerCase() : "0");

/**
 * Suffixes for markets whose base label collides with another's. With the
 * whole Morpho universe in the roster, the same legs + LLTVs + maturity recur
 * across books that differ only in an ORACLE (13 on Ethereum alone), an
 * rcf threshold, a gate — or a chain. Two rows that render identically are the
 * repo's standing identity bug, so a colliding group gets the FIRST of these
 * that tells every member apart: chain, leg oracles, rcf, gates, market id.
 * Only colliding rows get a suffix.
 */
export function disambiguateMidnightLabels(
  rows: Pick<LabelRow, "key" | "chainId" | "market" | "base">[],
): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = groups.get(r.base) ?? [];
    g.push(r);
    groups.set(r.base, g);
  }
  const discriminators: ((r: (typeof rows)[number]) => string)[] = [
    (r) => CHAIN_SHORT[r.chainId] ?? `chain ${r.chainId}`,
    (r) =>
      `oracle ${r.market.collaterals.map((c) => short(c.oracle)).join("/")}`,
    (r) => `rcf ${r.market.rcfThreshold}`,
    (r) =>
      isZeroAddr(r.market.enterGate) && isZeroAddr(r.market.liquidatorGate)
        ? "ungated"
        : `gate ${short(r.market.enterGate)}/${short(r.market.liquidatorGate)}`,
    (r) => `#${r.market.marketId.slice(2, 10).toLowerCase()}`,
  ];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Chain first, then within each chain the first field that separates it.
    const byChain = new Map<string, typeof rows>();
    for (const r of g)
      byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
    const multiChain = byChain.size > 1;
    for (const members of byChain.values()) {
      const parts = new Map<string, string[]>();
      for (const r of members)
        parts.set(r.key, multiChain ? [discriminators[0](r)] : []);
      if (members.length > 1) {
        const d =
          discriminators
            .slice(1)
            .find((f) => new Set(members.map(f)).size === members.length) ??
          discriminators[discriminators.length - 1];
        for (const r of members) parts.get(r.key)!.push(d(r));
      }
      for (const r of members) {
        const p = parts.get(r.key)!;
        if (p.length > 0) out.set(r.key, p.join(" "));
      }
    }
  }
  return out;
}

/**
 * Morpho Midnight is a fixed-rate, fixed-maturity order-book protocol. Markets
 * EXPIRE and roll on a cadence, so this updater rebuilds the live market set per
 * chain on every run.
 *
 * The roster is **Morpho's universe, cut to markets with a book or a position,
 * plus everything Tenor curates** (see `fetchRoster` / `keepUniverseMarket`),
 * minus Tenor maturities never created on-chain. Every market id is re-derived
 * from its own struct before it is written (see `verifyMarketIds`), curation
 * keeps anything unmatured or still holding units (see `curate`), and markets
 * the sources stop serving are carried forward until verified empty on-chain
 * (see `selectCarryForward`). Output → `data/midnight-markets.json`, shape
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
    const labelRows: LabelRow[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    // Previous snapshot, needed by the carry-forward guard below. Absence is
    // fine (first run) — there is simply nothing to carry.
    let previous: Record<string, any[]> = {};
    try {
      previous = JSON.parse(readFileSync(MARKETS_FILE, "utf8"));
    } catch {}

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
      let source: string;
      let universe = false;
      let tenorOnly = new Set<string>();
      try {
        const fetched = await fetchRoster(chainId, config[chainId], nowSec);
        roster = fetched.markets;
        source = fetched.source;
        universe = fetched.universe;
        tenorOnly = fetched.tenorOnly;
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

      // Phantoms: Tenor markets Morpho does not know AND that were never
      // created on-chain. Nothing can be read or taken there; dropped only on
      // proof (a failed read keeps the market).
      const phantomCandidates = verified.filter(
        (m) =>
          tenorOnly.has(m.marketId.toLowerCase()) &&
          BigInt(m.totalUnits ?? "0") === 0n,
      );
      const created = await resolveMarketCreated(
        chainId,
        midnight,
        phantomCandidates.map((m) => m.marketId),
      );
      const phantoms = new Set(
        phantomCandidates
          .map((m) => m.marketId.toLowerCase())
          .filter((id) => created[id] === false),
      );
      const real = verified.filter(
        (m) => !phantoms.has(m.marketId.toLowerCase()),
      );

      const { kept, dropped } = curate(real, nowSec);
      console.log(
        `Midnight: chain ${chainId}: ${kept.length} markets from ${source} ` +
          `(${roster.length} fetched, ${roster.length - verified.length} failed id check, ` +
          `${phantoms.size} never created on-chain, ${dropped} dropped as matured+empty)`,
      );

      // Carry-forward guard (see `selectCarryForward`): previously-published
      // markets the source no longer serves. Compared against `verified`, not
      // `roster`, so a market whose struct the source now serves BROKEN also
      // falls back to our stored (self-verifying) copy instead of vanishing.
      const prevChain: any[] = Array.isArray(previous[chainId])
        ? previous[chainId]
        : [];
      const verifiedIds = new Set(
        verified.map((m) => m.marketId.toLowerCase()),
      );
      const missing = prevChain.filter(
        (e) => e?.marketId && !verifiedIds.has(e.marketId.toLowerCase()),
      );
      if (missing.length > 0) {
        const units = await resolveTotalUnits(
          chainId,
          midnight,
          missing.map((e) => e.marketId),
        );
        const { carried, retired } = selectCarryForward(
          missing,
          units,
          nowSec,
          universe,
        );
        for (const e of retired)
          console.log(
            `Midnight: chain ${chainId}: market ${e.marketId} (${e.name ?? "?"}) left the ${source} roster and is empty on-chain — retired`,
          );
        if (carried.length > 0) {
          const rosters = carried.map((e) =>
            rosterFromStoredEntry(chainId, e, units[e.marketId.toLowerCase()]),
          );
          const ok = verifyMarketIds(chainId, midnight, rosters);
          for (const m of ok)
            console.log(
              `Midnight: chain ${chainId}: market ${m.marketId} missing from the ${source} roster but ` +
                `${Number(m.maturity) > nowSec ? "unmatured" : "still holding units"} — carried forward`,
            );
          kept.push(...ok);
        }
      }

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
      // Fees: Morpho's API first (every `/markets` row carries them); the
      // on-chain `marketState` snapshot only for markets it did not cover.
      const fees = await resolveMarketFees(
        chainId,
        midnight,
        kept.filter((m) => !m.apiFees).map((m) => m.marketId),
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

          const base = `${collLabel}-${loanSym} ${bpsLabel} ${date}`
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

          // Morpho's API copy of the mutable fees when it has one; otherwise the
          // on-chain snapshot; otherwise whatever Tenor reported.
          const f = m.apiFees ? undefined : fees[m.marketId.toLowerCase()];
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
          labelRows.push({ key, chainId, market: m, base, entry });
          return entry;
        });

      console.log(`Midnight: chain ${chainId}: ${markets.length} markets`);
      result[chainId] = markets;
    }

    // Names are global (one label space over every chain), so collisions are
    // resolved over the whole run — see `disambiguateMidnightLabels`.
    const suffix = disambiguateMidnightLabels(labelRows);
    for (const r of labelRows) {
      const sfx = suffix.get(r.key);
      names[r.key] = `Midnight ${r.base}${sfx ? ` · ${sfx}` : ""}`;
      shortNames[r.key] = `MN ${r.base}${sfx ? ` · ${sfx}` : ""}`;
      if (sfx) r.entry.name = `${r.entry.name} · ${sfx}`;
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
