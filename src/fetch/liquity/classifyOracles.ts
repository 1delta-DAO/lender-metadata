import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";

// Liquity V2 PriceFeeds are custom composite contracts the generic resolver can't
// walk, but every mainnet-style branch anchors on a Chainlink ETH/USD aggregator
// exposed via `ethUsdOracle()` (an `Oracle` struct whose first field is the
// aggregator). We read that, resolve the *aggregator* (a standard Chainlink feed),
// and report its provider/description as the branch's underlying anchor.
const ETH_USD_ORACLE_ABI = [
  { name: "ethUsdOracle", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
] as const;

// data/liquity-markets.json: LENDER -> chain -> branches[] (each with priceFeed, collToken, collIndex)
const marketsFile = "./data/liquity-markets.json";

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: any): a is string =>
  typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;

type Branch = {
  collIndex: number;
  collToken?: string;
  collSymbol?: string | null;
  priceFeed?: string;
  name?: string;
};

export type LiquityBranchOracle = {
  /** App lender key `<LENDER>_<chainId>_<collIndex>` IS the nesting key. */
  lender: string;
  collIndex: number;
  collToken: string;
  boldToken?: string | null;
  collSymbol: string | null;
  /** Branch PriceFeed contract. */
  oracle: string | null;
  source: string | null;
  provider: string;
  rawDescription: string | null;
  priceDescription: string;
  fixedRate: true | null;
  underlyingAggregator: string | null;
  sourcePath: Array<{ address: string; description: string | null; decimals: number | null; kind: string }>;
  intendedPair: string | null;
  correctOracle: true | false | null;
  denominatorMatch: true | false | null;
};

export type LiquityOraclesClassifiedMap = {
  [chainId: string]: { [appLenderKey: string]: LiquityBranchOracle };
};

/**
 * Classify Liquity V2 (+ fork) branch price oracles.
 *
 * Each collateral branch has its own `PriceFeed` contract pricing the collateral in
 * USD (BOLD is the USD-pegged loan asset). Branches are enumerated per lender/chain
 * from liquity-markets.json; the feed graph is walked with the shared resolver and
 * assessed against `<collateral> / USD`. Output nests `chain → <LENDER>_<chainId>_<collIndex>
 * → entry` so risk-data's normalizeLiquity can key marketUids directly.
 */
export async function classifyLiquityOracles(): Promise<LiquityOraclesClassifiedMap> {
  const markets = readJsonFile(marketsFile) as Record<string, Record<string, Branch[]>>;

  // Regroup LENDER→chain→branches into chain→[{lender, branch}] for per-chain batching.
  const byChain: Record<string, Array<{ lender: string; br: Branch }>> = {};
  for (const [lender, chains] of Object.entries(markets ?? {})) {
    if (lender.startsWith("_")) continue;
    for (const [chainId, branches] of Object.entries(chains ?? {})) {
      for (const br of branches ?? []) {
        if (br?.collIndex == null || !isAddr(br.priceFeed) || !isAddr(br.collToken)) continue;
        (byChain[chainId] ??= []).push({ lender, br });
      }
    }
  }

  const result: LiquityOraclesClassifiedMap = {};

  for (const [chainId, items] of Object.entries(byChain)) {
    console.log(`Liquity oracles [${chainId}]: ${items.length} branches`);

    // Collateral symbols (fall back to the branch's own symbol if present).
    const collTokens = [...new Set(items.map((x) => x.br.collToken!.toLowerCase()))];
    const symRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: collTokens.map((t) => ({ address: t, name: "symbol", args: [] })),
      abi: SYMBOL_ABI,
      allowFailure: true,
      maxRetries: 8,
    }).catch(() => [])) as unknown[];
    const symByToken = new Map<string, string | null>();
    collTokens.forEach((t, i) => symByToken.set(t, asString(symRes[i])));

    const priceFeeds = [...new Set(items.map((x) => x.br.priceFeed!.toLowerCase()).filter(isAddr))];

    // Extract each branch's underlying Chainlink ETH/USD anchor via ethUsdOracle().
    const anchorRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: priceFeeds.map((pf) => ({ address: pf, name: "ethUsdOracle", args: [] })),
      abi: ETH_USD_ORACLE_ABI as any,
      allowFailure: true,
      maxRetries: 4,
    }).catch(() => [])) as unknown[];
    const anchorByFeed = new Map<string, string | null>();
    priceFeeds.forEach((pf, i) => anchorByFeed.set(pf, toAddr(anchorRes[i])));

    // Resolve the anchors (standard Chainlink feeds); fall back to the PriceFeed
    // itself for branches with no ethUsdOracle (non-ETH forks — stays UNKNOWN).
    const feeds = [...new Set([
      ...[...anchorByFeed.values()].filter(isAddr),
      ...priceFeeds,
    ])] as string[];
    const graph = feeds.length ? await probeFeedGraph(chainId, feeds) : new Map();
    const resolvedByFeed = new Map(feeds.map((f) => [f, resolveFeed(f, graph)]));

    result[chainId] = {};
    for (const { lender, br } of items) {
      const feed = br.priceFeed!.toLowerCase();
      const collToken = br.collToken!.toLowerCase();
      const collSymbol = br.collSymbol ?? symByToken.get(collToken) ?? null;
      const anchor = anchorByFeed.get(feed) ?? null;
      // Prefer the resolved ETH/USD anchor; otherwise the (opaque) PriceFeed.
      const resolved = (anchor && isAddr(anchor) ? resolvedByFeed.get(anchor) : null) ?? resolvedByFeed.get(feed) ?? null;
      const a = resolved
        ? assessFeed(resolved, collSymbol, "USD")
        : { denominator: null, intendedPair: collSymbol ? `${collSymbol} / USD` : null, correctOracle: null, denominatorMatch: null };

      // The anchor confirms the Chainlink base + USD numeraire, but Liquity composes
      // the collateral price (base ETH/USD × a per-collateral rate) that the generic
      // resolver can't verify — so we report the anchor's provider/description and the
      // USD denominator match, but leave correctOracle null (not falsely wrong-asset).
      const anchored = !!(anchor && isAddr(anchor) && resolved && resolved.priceDescription !== "UNKNOWN");

      result[chainId][`${lender}_${chainId}_${br.collIndex}`] = {
        lender,
        collIndex: br.collIndex,
        collToken,
        collSymbol,
        oracle: feed,
        source: feed,
        provider: anchored ? resolved!.provider : resolved?.provider ?? "liquity-pricefeed",
        rawDescription: resolved?.rawDescription ?? null,
        priceDescription: resolved?.priceDescription ?? "UNKNOWN",
        fixedRate: resolved?.fixedRate ?? null,
        underlyingAggregator: anchor && isAddr(anchor) ? anchor : resolved?.underlyingAggregator ?? null,
        sourcePath: resolved?.sourcePath ?? [],
        intendedPair: collSymbol ? `${collSymbol} / USD` : a.intendedPair,
        correctOracle: anchored ? null : a.correctOracle,
        denominatorMatch: anchored ? a.denominatorMatch : a.denominatorMatch,
      };
    }
  }

  return result;
}
