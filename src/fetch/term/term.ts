import { DataUpdater } from "../../types.js";
import { readJsonFile } from "../utils/index.js";
import { mergeData as deepMergeData, sortRecord } from "../../utils.js";

const MARKETS_FILE = "./data/term-finance-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/term-finance.json";

/**
 * Ormi-hosted Term subgraph per chain. Kept here (not in config) to match the
 * margin-fetcher's `TERM_SUBGRAPH_BY_CHAIN`; `config.apiBaseUrl` overrides.
 */
const SUBGRAPH_BY_CHAIN: Record<string, string> = {
  "1": "https://api.subgraph.ormilabs.com/api/public/05e9a4e2-103b-4163-a81e-3b1b038d0055/subgraphs/term-finance-mainnet/latest/gn",
  "43114":
    "https://api.subgraph.ormilabs.com/api/public/05e9a4e2-103b-4163-a81e-3b1b038d0055/subgraphs/term-finance-avalanche/latest/gn",
  "56": "https://api.subgraph.ormilabs.com/api/public/05e9a4e2-103b-4163-a81e-3b1b038d0055/subgraphs/term-finance-bnb/latest/gn",
  "8453":
    "https://api.subgraph.ormilabs.com/api/public/05e9a4e2-103b-4163-a81e-3b1b038d0055/subgraphs/term-finance-base/latest/gn",
  "42161":
    "https://api.subgraph.ormilabs.com/api/public/05e9a4e2-103b-4163-a81e-3b1b038d0055/subgraphs/term-finance-arbitrum/latest/gn",
};

/**
 * How far past redemption a repo stays in the file. A matured repo is no longer
 * borrowable, but a borrower can still hold debt through the repurchase window
 * and a lender still holds repo tokens to redeem — dropping it on the maturity
 * tick would make those positions unreadable. One week past redemption is well
 * clear of the repurchase window.
 */
const KEEP_AFTER_REDEMPTION_SECS = 7 * 86400;

/** How far ahead to list repos whose auction hasn't happened yet. */
const REPO_PAGE = 500;

const isoDate = (unixSecs: number): string =>
  new Date(unixSecs * 1000).toISOString().slice(0, 10);

interface TermRepoNode {
  id: string;
  termRepoServicer?: string;
  termRepoCollateralManager?: string;
  termRepoToken?: string;
  termRepoTokenRedemptionRatio?: string;
  purchaseToken?: string;
  purchaseTokenMeta?: { symbol?: string; decimals?: string };
  repurchaseTimestamp?: string;
  redemptionTimestamp?: string;
  endOfRepurchaseWindow?: string;
  servicingFee?: string;
  delisted?: boolean;
  collateralRatios?: { collateralToken: string; maintenanceRatio: string }[];
  liquidatedDamagesSchedule?: {
    collateralToken: string;
    liquidatedDamages: string;
  }[];
  collateralTokensMeta?: { id: string; symbol?: string; decimals?: string }[];
}

interface TermAuctionNode {
  id: string;
  auction?: string;
  auctionBidLocker?: string;
  auctionOfferLocker?: string;
  auctionEndTime?: string;
  auctionComplete?: boolean;
  auctionCancelled?: boolean;
  delisted?: boolean;
  term?: { id?: string };
}

async function gql(
  url: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<any | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      console.log(`Term: subgraph HTTP ${res.status} (${url})`);
      return null;
    }
    const json: any = await res.json();
    if (json?.errors) {
      console.log("Term: subgraph errors", JSON.stringify(json.errors));
      return null;
    }
    return json?.data ?? null;
  } catch (e) {
    console.log("Term: subgraph fetch failed:", (e as any)?.message ?? e);
    return null;
  }
}

const REPOS_QUERY = `
  query Repos($cutoff: BigInt!, $n: Int!, $skip: Int!) {
    termRepos(
      where: { redemptionTimestamp_gt: $cutoff, delisted: false }
      orderBy: redemptionTimestamp
      orderDirection: asc
      first: $n
      skip: $skip
    ) {
      id
      termRepoServicer
      termRepoCollateralManager
      termRepoToken
      termRepoTokenRedemptionRatio
      purchaseToken
      purchaseTokenMeta { symbol decimals }
      repurchaseTimestamp
      redemptionTimestamp
      endOfRepurchaseWindow
      servicingFee
      delisted
      collateralRatios { collateralToken maintenanceRatio }
      liquidatedDamagesSchedule { collateralToken liquidatedDamages }
      collateralTokensMeta { id symbol decimals }
    }
  }`;

// Locker addresses live on the AUCTION, not the repo — and they must come from
// ALL rounds, not just `termRepo.completedAuctions`: a repo in its FIRST round
// has no completed auction yet, which is exactly the case (a freshly listed,
// currently-biddable market) we most need to publish.
const AUCTIONS_QUERY = `
  query Auctions($terms: [String!]!, $n: Int!, $skip: Int!) {
    termAuctions(
      where: { term_in: $terms }
      orderBy: auctionEndTime
      orderDirection: desc
      first: $n
      skip: $skip
    ) {
      id
      auction
      auctionBidLocker
      auctionOfferLocker
      auctionEndTime
      auctionComplete
      auctionCancelled
      delisted
      term { id }
    }
  }`;

/** Page a subgraph list query until it returns fewer than `REPO_PAGE` rows. */
async function fetchAllPages<T>(
  url: string,
  query: string,
  variables: Record<string, unknown>,
  field: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; skip < 5000; skip += REPO_PAGE) {
    const data = await gql(url, query, {
      ...variables,
      n: REPO_PAGE,
      skip,
    });
    const page = (data?.[field] ?? []) as T[];
    out.push(...page);
    if (page.length < REPO_PAGE) break;
  }
  return out;
}

/**
 * Pick the locker set to publish for a repo.
 *
 * Preference order is deliberate: the round a user can act on NOW beats the
 * historical one. An uncleared round (not complete, not cancelled, not
 * delisted, clearing in the future) wins; otherwise the most recently ended
 * round, which is what a matured repo's positions were opened against.
 */
export function pickAuctionForRepo(
  auctions: TermAuctionNode[],
  nowSec: number,
): TermAuctionNode | undefined {
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const live = auctions
    .filter(
      (a) =>
        !a.delisted &&
        !a.auctionComplete &&
        !a.auctionCancelled &&
        num(a.auctionEndTime) > nowSec,
    )
    .sort((a, b) => num(a.auctionEndTime) - num(b.auctionEndTime));
  if (live.length) return live[0];
  return [...auctions]
    .filter((a) => !a.delisted)
    .sort((a, b) => num(b.auctionEndTime) - num(a.auctionEndTime))[0];
}

/** Build the published market record for one repo. */
function toMarket(
  repo: TermRepoNode,
  auction: TermAuctionNode | undefined,
): Record<string, unknown> | null {
  if (!repo?.id || !repo.purchaseToken) return null;

  const metaOf = (addr: string) =>
    (repo.collateralTokensMeta ?? []).find(
      (m) => String(m.id).toLowerCase() === addr.toLowerCase(),
    );
  const damagesOf = (addr: string) =>
    (repo.liquidatedDamagesSchedule ?? []).find(
      (d) => String(d.collateralToken).toLowerCase() === addr.toLowerCase(),
    )?.liquidatedDamages;

  const collateralParams = (repo.collateralRatios ?? []).map((c) => {
    const meta = metaOf(c.collateralToken);
    return {
      token: c.collateralToken.toLowerCase(),
      maintenanceRatio: String(c.maintenanceRatio),
      decimals: Number(meta?.decimals ?? 18),
      // Absent for a few legacy repos; the margin-fetcher falls back to an
      // LLTV-derived penalty, so omit rather than publish a fabricated 0.
      ...(damagesOf(c.collateralToken)
        ? { liquidatedDamages: String(damagesOf(c.collateralToken)) }
        : {}),
    };
  });
  if (collateralParams.length === 0) return null;

  // `repurchaseTimestamp` is the borrower's repay deadline — the maturity the
  // rate is quoted to. `redemptionTimestamp` (a day later) is when lenders can
  // redeem repo tokens. Conflating them overstates the term by a day.
  const maturity = String(repo.repurchaseTimestamp ?? repo.redemptionTimestamp);
  const loanSym = repo.purchaseTokenMeta?.symbol ?? "?";
  const collSyms =
    collateralParams
      .map((c) => metaOf(c.token as string)?.symbol ?? "?")
      .join(" / ") || "?";

  return {
    termRepoId: repo.id.toLowerCase(),
    servicer: String(repo.termRepoServicer ?? "").toLowerCase(),
    repoToken: String(repo.termRepoToken ?? "").toLowerCase(),
    collateralManager: String(
      repo.termRepoCollateralManager ?? "",
    ).toLowerCase(),
    purchaseToken: repo.purchaseToken.toLowerCase(),
    loanDecimals: Number(repo.purchaseTokenMeta?.decimals ?? 18),
    collateralParams,
    maturity,
    redemptionTimestamp: String(repo.redemptionTimestamp ?? maturity),
    name: `${loanSym} / ${collSyms} — ${isoDate(Number(maturity))}`,
    endOfRepurchaseWindow: String(repo.endOfRepurchaseWindow ?? maturity),
    redemptionValue: String(
      repo.termRepoTokenRedemptionRatio ?? "1000000000000000000",
    ),
    servicingFee: String(repo.servicingFee ?? "0"),
    // Auction addresses are OPTIONAL in `TermMarketConfig` and omitted — not
    // blanked — when no round exists. Roughly two thirds of listed repos are in
    // that state: a repo is deployed with its maturity and collateral params
    // first, and its TermAuction entity only appears when a round is actually
    // scheduled. Writing "" instead would hand a caller an address-shaped value
    // that isn't one.
    ...(auction?.auction ? { auction: auction.auction.toLowerCase() } : {}),
    ...(auction?.auctionOfferLocker
      ? { offerLocker: auction.auctionOfferLocker.toLowerCase() }
      : {}),
    ...(auction?.auctionBidLocker
      ? { bidLocker: auction.auctionBidLocker.toLowerCase() }
      : {}),
  };
}

/**
 * Rebuild `data/term-finance-markets.json` from the Term subgraph.
 *
 * Term repos EXPIRE — each is a single-maturity tri-party repo, and new ones
 * are listed continuously — so a hand-committed snapshot goes stale within
 * weeks: repos that matured keep being advertised as borrowable, and repos with
 * a currently-open auction (the only ones that can actually be borrowed) are
 * missing entirely. This rebuilds the live set per chain each run, exactly like
 * the Midnight updater does for its expiring markets.
 *
 * Chains come from `config/term-finance.json`; a chain with no subgraph is
 * skipped rather than emptied.
 */
export class TermMarketsUpdater implements DataUpdater {
  name = "Term Finance Markets";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    const config = (readJsonFile(CONFIG_FILE) ?? {}) as Record<
      string,
      { apiBaseUrl?: string | null }
    >;
    const chainIds = Object.keys(config);
    if (chainIds.length === 0) {
      console.log("Term: no chains in config/term-finance.json, skipping");
      return { [MARKETS_FILE]: {} };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - KEEP_AFTER_REDEMPTION_SECS;
    const result: Record<string, any[]> = {};

    for (const chainId of chainIds) {
      const url = config[chainId]?.apiBaseUrl || SUBGRAPH_BY_CHAIN[chainId];
      if (!url) {
        console.log(`Term: chain ${chainId}: no subgraph configured, skipping`);
        continue;
      }

      const repos = await fetchAllPages<TermRepoNode>(
        url,
        REPOS_QUERY,
        { cutoff: String(cutoff) },
        "termRepos",
      );
      if (repos.length === 0) {
        console.log(`Term: chain ${chainId}: 0 live repos`);
        result[chainId] = [];
        continue;
      }

      const auctions = await fetchAllPages<TermAuctionNode>(
        url,
        AUCTIONS_QUERY,
        { terms: repos.map((r) => r.id.toLowerCase()) },
        "termAuctions",
      );
      const byTerm = new Map<string, TermAuctionNode[]>();
      for (const a of auctions) {
        const t = String(a.term?.id ?? "").toLowerCase();
        if (!t) continue;
        const arr = byTerm.get(t);
        if (arr) arr.push(a);
        else byTerm.set(t, [a]);
      }

      const markets = repos
        .map((r) =>
          toMarket(r, pickAuctionForRepo(byTerm.get(r.id.toLowerCase()) ?? [], nowSec)),
        )
        .filter((m): m is Record<string, unknown> => m !== null)
        .sort((a, b) =>
          String(a.termRepoId) < String(b.termRepoId) ? -1 : 1,
        );

      const openNow = markets.filter(
        (m) => Number(m.maturity) > nowSec,
      ).length;
      console.log(
        `Term: chain ${chainId}: ${markets.length} repos (${openNow} unmatured)`,
      );
      result[chainId] = markets;
    }

    return {
      [MARKETS_FILE]: result,
      // Labels are produced in the SAME run that discovers the repos, so a new
      // maturity is never published nameless (see `buildTermLabels`).
      [LABELS_FILE]: buildTermLabels(result as any),
    };
  }

  /**
   * Replace each chain's list with the freshly-fetched set — repos expire, so
   * append-only would accumulate dead markets forever (which is how the file
   * got stale in the first place). Guard: a chain that fetched EMPTY but
   * previously had markets keeps its old data, so a transient subgraph outage
   * doesn't wipe a live chain.
   */
  mergeData(oldData: any, data: any, fileKey: string): any {
    // Labels are shared across every lender family, so they must ACCUMULATE —
    // replacing would wipe Morpho/Silo/etc. Matured repos keep their names too,
    // so a user still holding a position can read it.
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

/** Synthesized per-repo lender enum key, mirroring the margin-fetcher's `termLenderKey`. */
export const termLenderKey = (repoId: string): string =>
  `TERM_FINANCE_${repoId.replace(/^0x/i, "").toUpperCase()}`;

/**
 * Display labels for every repo, keyed by the synthesized lender enum.
 *
 * The frontend resolves market names from `lender-labels.json`, so a repo with
 * no entry renders as the raw `TERM_FINANCE_1AF24BEC…` key — and since a pair
 * has one repo per maturity, several truncated raw keys are indistinguishable
 * from each other. Maturity is therefore part of the label, not decoration.
 *
 * Built here (rather than in a separate pass) so the nightly `update:dataset`
 * job names new repos in the same run that discovers them; label drift was
 * exactly the gap that left every Term market nameless.
 */
export function buildTermLabels(markets: Record<string, TermMarketRow[]>): {
  names: Record<string, string>;
  shortNames: Record<string, string>;
} {
  // Base lender label (the bare key the user-data path uses).
  const names: Record<string, string> = { TERM_FINANCE: "Term Finance" };
  const shortNames: Record<string, string> = { TERM_FINANCE: "Term" };

  for (const rows of Object.values(markets ?? {})) {
    for (const r of rows ?? []) {
      if (!r?.termRepoId) continue;
      const key = termLenderKey(r.termRepoId);
      const { pair, date } = parseMarketName(r.name);
      // The name's date and the maturity timestamp agree, but the timestamp is
      // authoritative — fall back to the parsed date only when it's missing.
      const day = maturityDate(r.maturity) || date || "";
      if (pair) {
        names[key] = `Term ${pair.replace(/\//g, " / ")}${day ? ` — ${day}` : ""}`;
        shortNames[key] = `TF ${pair}${day ? ` ${day}` : ""}`;
      } else {
        // No parseable pair — still better than the raw enum key.
        names[key] = `Term Finance${day ? ` — ${day}` : ""}`;
        shortNames[key] = `TF${day ? ` ${day}` : ""}`;
      }
    }
  }
  return { names: sortRecord(names), shortNames: sortRecord(shortNames) };
}

/** `1788451200` → `"2026-09-03"` (UTC). Empty when the timestamp is unusable. */
function maturityDate(maturity: unknown): string {
  const secs = Number(maturity);
  if (!Number.isFinite(secs) || secs <= 0) return "";
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

/**
 * Split "<purchase> / <collateral> — <date>" into its parts. Term names use an
 * EM DASH before the date and " / " between the legs; anything that doesn't
 * match returns nulls and lets the caller fall back to the maturity.
 */
function parseMarketName(name: string | undefined): {
  pair: string | null;
  date: string | null;
} {
  if (!name) return { pair: null, date: null };
  const [legs, date] = name.split("\u2014").map((x) => x.trim());
  if (!legs) return { pair: null, date: null };
  // "USDC / wstETH" → "USDC/wstETH" (the short label has no width to spare).
  const pair = legs
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .join("/");
  return { pair: pair || null, date: date || null };
}

/** Row shape of the published markets file (what `buildTermLabels` reads). */
export interface TermMarketRow {
  termRepoId: string;
  maturity?: string | number;
  name?: string;
}
