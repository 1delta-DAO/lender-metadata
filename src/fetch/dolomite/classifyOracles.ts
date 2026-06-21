import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";

const marginFile = "./config/dolomite-margin.json"; // chain -> { dolomiteMargin, markets: { id -> token } }

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: any): a is string =>
  typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;

const MARGIN_ABI = [
  { name: "getMarketPriceOracle", stateMutability: "view", type: "function", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
] as const;
// Dolomite oracle aggregators expose a per-token Chainlink aggregator getter.
const AGG_ABI = [
  { name: "getAggregatorByToken", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { name: "aggregators", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

export type DolomiteOracleMarketData = {
  /** Numeric marketId — the leaf (marketUid = DOLOMITE:<chain>:<marketId>). */
  marketId: string;
  asset: string;
  assetSymbol: string | null;
  oracle: string | null;
  source: string | null;
  rawDescription: string | null;
  priceDescription: string;
  provider: string;
  fixedRate: true | null;
  underlyingAggregator: string | null;
  sourcePath: Array<{ address: string; description: string | null; decimals: number | null; kind: string }>;
  denominator: string | null;
  intendedPair: string | null;
  correctOracle: true | false | null;
  denominatorMatch: true | false | null;
};

export type DolomiteOraclesClassifiedMap = {
  [chainId: string]: { [marketId: string]: DolomiteOracleMarketData };
};

export async function classifyDolomiteOracles(): Promise<DolomiteOraclesClassifiedMap> {
  const margin = readJsonFile(marginFile) as Record<
    string,
    { dolomiteMargin: string; markets: Record<string, string> }
  >;

  const result: DolomiteOraclesClassifiedMap = {};

  for (const [chainId, cfg] of Object.entries(margin)) {
    const markets = Object.entries(cfg.markets ?? {})
      .map(([id, token]) => ({ id, token: toAddr(token) }))
      .filter((m): m is { id: string; token: string } => isAddr(m.token));
    if (!markets.length || !isAddr(cfg.dolomiteMargin)) continue;
    console.log(`Dolomite oracles [${chainId}]: ${markets.length} markets`);

    // 1. per-market price oracle
    const oracleRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: markets.map((m) => ({ address: cfg.dolomiteMargin, name: "getMarketPriceOracle", args: [m.id] })),
      abi: MARGIN_ABI as any,
      allowFailure: true,
      maxRetries: 4,
    }).catch(() => [])) as any[];
    const oracleByMarket = new Map<string, string | null>();
    markets.forEach((m, i) => oracleByMarket.set(m.id, toAddr(oracleRes[i])));

    // 2. symbols
    const tokens = [...new Set(markets.map((m) => m.token))];
    const symRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: tokens.map((t) => ({ address: t, name: "symbol", args: [] })),
      abi: SYMBOL_ABI,
      allowFailure: true,
      maxRetries: 12,
    }).catch(() => [])) as unknown[];
    const symbolByToken = new Map<string, string | null>();
    tokens.forEach((t, i) => symbolByToken.set(t, asString(symRes[i])));

    // 3. try to resolve a per-token Chainlink aggregator from each market's oracle.
    const feedByMarket = new Map<string, string | null>();
    for (const m of markets) {
      const oracle = oracleByMarket.get(m.id);
      if (!oracle || !isAddr(oracle)) { feedByMarket.set(m.id, null); continue; }
      let feed: string | null = null;
      for (const name of ["getAggregatorByToken", "aggregators"] as const) {
        const r = (await multicallRetryUniversal({
          chain: chainId, calls: [{ address: oracle, name, args: [m.token] }], abi: AGG_ABI as any, allowFailure: true, maxRetries: 2,
        }).catch(() => [])) as any[];
        const f = toAddr(r[0]);
        if (isAddr(f)) { feed = f; break; }
      }
      feedByMarket.set(m.id, feed);
    }

    // 4. probe decoded feeds
    const feeds = [...new Set([...feedByMarket.values()].filter(isAddr))] as string[];
    const graph = feeds.length ? await probeFeedGraph(chainId, feeds) : new Map();
    const resolvedByFeed = new Map(feeds.map((f) => [f, resolveFeed(f, graph)]));

    result[chainId] = {};
    for (const m of markets) {
      const oracle = oracleByMarket.get(m.id) ?? null;
      const feed = feedByMarket.get(m.id) ?? null;
      const resolved = feed && isAddr(feed) ? resolvedByFeed.get(feed) ?? null : null;
      const assetSymbol = symbolByToken.get(m.token) ?? null;
      const a = resolved
        ? assessFeed(resolved, assetSymbol, "USD")
        : { denominator: null, intendedPair: assetSymbol ? `${assetSymbol} / USD` : null, correctOracle: null, denominatorMatch: null };

      result[chainId][m.id] = {
        marketId: m.id,
        asset: m.token,
        assetSymbol,
        oracle,
        source: feed && isAddr(feed) ? feed : null,
        rawDescription: resolved?.rawDescription ?? null,
        priceDescription: resolved?.priceDescription ?? "UNKNOWN",
        provider: resolved?.provider ?? "dolomite-oracle",
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
