import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import {
  probeFeedGraph,
  resolveFeed,
} from "../oracle-classifier/feedResolver.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";

// config/term-finance.json: chain -> { priceOracle, ... }
const configFile = "./config/term-finance.json";
// data/term-finance-markets.json: chain -> [{ purchaseToken, collateralParams:[{token}], ... }]
const marketsFile = "./data/term-finance-markets.json";

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: any): a is string =>
  typeof a === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(a) &&
  a.toLowerCase() !== ZERO;

// TermPriceConsumerV3.getPriceFeedConfig(token) → (priceFeed, refreshRateThreshold)
const CONSUMER_ABI = [
  {
    name: "getPriceFeedConfig",
    stateMutability: "view",
    type: "function",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "priceFeed", type: "address" },
      { name: "refreshRateThreshold", type: "uint256" },
    ],
  },
] as const;

export type TermOracleTokenData = {
  /** Token address — the leaf id (marketUid = TERM_FINANCE_<repo>:<chain>:<token>). */
  asset: string;
  assetSymbol: string | null;
  /** TermPriceConsumerV3-registered primary price feed for this token. */
  oracle: string | null;
  source: string | null;
  rawDescription: string | null;
  priceDescription: string;
  provider: string;
  fixedRate: true | null;
  underlyingAggregator: string | null;
  sourcePath: Array<{
    address: string;
    description: string | null;
    decimals: number | null;
    kind: string;
  }>;
  denominator: string | null;
  intendedPair: string | null;
  correctOracle: true | false | null;
  denominatorMatch: true | false | null;
};

export type TermOraclesClassifiedMap = {
  [chainId: string]: { [token: string]: TermOracleTokenData };
};

/**
 * Classify Term Finance's price oracles.
 *
 * Term values every collateral + purchase token against one singleton
 * `TermPriceConsumerV3` per chain (`config.priceOracle`), which registers a
 * Chainlink-style feed per token (`getPriceFeedConfig(token).priceFeed`), all
 * USD-denominated. Oracles are per-TOKEN (shared across the 60 repos), so this
 * classifies each unique token once; a `TERM_FINANCE_<repo>` market joins by
 * the token leaf of its marketUid.
 */
export async function classifyTermOracles(): Promise<TermOraclesClassifiedMap> {
  const config = readJsonFile(configFile) as Record<
    string,
    { priceOracle?: string | null }
  >;
  const marketsByChain = readJsonFile(marketsFile) as Record<
    string,
    Array<{
      purchaseToken?: string;
      collateralParams?: Array<{ token?: string }>;
    }>
  >;

  const result: TermOraclesClassifiedMap = {};

  for (const [chainId, repos] of Object.entries(marketsByChain ?? {})) {
    const oracle = config?.[chainId]?.priceOracle;
    if (!isAddr(oracle) || !Array.isArray(repos) || repos.length === 0) continue;

    // Unique token set across all repos (collateral + purchase token).
    const tokenSet = new Set<string>();
    for (const r of repos) {
      const p = toAddr(r.purchaseToken);
      if (isAddr(p)) tokenSet.add(p);
      for (const c of r.collateralParams ?? []) {
        const t = toAddr(c.token);
        if (isAddr(t)) tokenSet.add(t);
      }
    }
    const tokens = [...tokenSet];
    if (!tokens.length) continue;
    console.log(`Term oracles [${chainId}]: ${tokens.length} tokens`);

    // 1. per-token primary price feed from the consumer.
    const feedRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: tokens.map((t) => ({
        address: oracle,
        name: "getPriceFeedConfig",
        args: [t],
      })),
      abi: CONSUMER_ABI as any,
      allowFailure: true,
      maxRetries: 4,
    }).catch(() => [])) as any[];
    const feedByToken = new Map<string, string | null>();
    tokens.forEach((t, i) => {
      const r = feedRes[i];
      const feed = Array.isArray(r) ? toAddr(r[0]) : toAddr(r?.priceFeed);
      feedByToken.set(t, feed);
    });

    // 2. on-chain symbols.
    const symRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: tokens.map((t) => ({ address: t, name: "symbol", args: [] })),
      abi: SYMBOL_ABI,
      allowFailure: true,
      maxRetries: 8,
    }).catch(() => [])) as unknown[];
    const symbolByToken = new Map<string, string | null>();
    tokens.forEach((t, i) => symbolByToken.set(t, asString(symRes[i])));

    // 3. probe + resolve unique feeds.
    const feeds = [
      ...new Set([...feedByToken.values()].filter(isAddr)),
    ] as string[];
    const graph = feeds.length ? await probeFeedGraph(chainId, feeds) : new Map();
    const resolvedByFeed = new Map(feeds.map((f) => [f, resolveFeed(f, graph)]));

    result[chainId] = {};
    for (const token of tokens) {
      const feed = feedByToken.get(token) ?? null;
      const resolved = feed && isAddr(feed) ? resolvedByFeed.get(feed) ?? null : null;
      const assetSymbol = symbolByToken.get(token) ?? null;
      const a = resolved
        ? assessFeed(resolved, assetSymbol, "USD")
        : {
            denominator: null,
            intendedPair: assetSymbol ? `${assetSymbol} / USD` : null,
            correctOracle: null,
            denominatorMatch: null,
          };

      result[chainId][token.toLowerCase()] = {
        asset: token,
        assetSymbol,
        oracle: feed && isAddr(feed) ? feed : null,
        source: feed && isAddr(feed) ? feed : null,
        rawDescription: resolved?.rawDescription ?? null,
        priceDescription: resolved?.priceDescription ?? "UNKNOWN",
        provider: resolved?.provider ?? "term-oracle",
        fixedRate: resolved?.fixedRate ?? null,
        underlyingAggregator: resolved?.underlyingAggregator ?? null,
        sourcePath: resolved?.sourcePath ?? [],
        denominator: a.denominator,
        intendedPair: a.intendedPair,
        correctOracle: a.correctOracle,
        denominatorMatch: a.denominatorMatch,
      };
    }
  }

  return result;
}
