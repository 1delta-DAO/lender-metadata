import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";

const oraclesFile = "./data/compound-v2-oracles.json"; // fork -> chain -> PriceOracle address
const cTokensFile = "./data/compound-v2-c-tokens.json"; // fork -> chain -> underlying -> cToken

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: any): a is string =>
  typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;

// Per-asset feed getters across the Compound-V2 oracle implementations we've seen:
//  - Venus ResilientOracle: getTokenConfig(token).oracles[0] → a ChainlinkOracle
//    whose tokenConfigs(token).feed is the Chainlink aggregator. (VENUS*, ENCLABS, SEGMENT)
//  - Moonwell ChainlinkOracle: getFeed(symbol) → aggregator directly.
// Forks whose oracle exposes neither are left undecoded (priceDescription UNKNOWN,
// correctOracle null) — never guessed.
const RESILIENT_ABI = [
  { name: "getTokenConfig", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [
    { type: "tuple", components: [
      { name: "asset", type: "address" },
      { name: "oracles", type: "address[3]" },
      { name: "enableFlagsForOracles", type: "bool[3]" },
    ] }] },
] as const;
const CHAINLINK_ORACLE_ABI = [
  { name: "tokenConfigs", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [
    { type: "tuple", components: [
      { name: "asset", type: "address" },
      { name: "feed", type: "address" },
      { name: "maxStalePeriod", type: "uint256" },
    ] }] },
] as const;
const GET_FEED_ABI = [
  { name: "getFeed", stateMutability: "view", type: "function", inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
] as const;
// Venus CorrelatedTokenOracle / OneJumpOracle: prices a correlated token (e.g.
// SolvBTC) via an underlying token (BTCB) through a resilient oracle + an
// exchange rate. It exposes no Chainlink getters, so the generic probe would
// mislabel it — detect it explicitly and classify as exchange-rate.
const CORRELATED_ABI = [
  { name: "CORRELATED_TOKEN", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
  { name: "UNDERLYING_TOKEN", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
  { name: "RESILIENT_ORACLE", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
] as const;

export type CompoundV2OracleAssetData = {
  /** cToken — the market's leaf identifier (marketUid = <fork>:<chain>:<cToken>). */
  cToken: string;
  asset: string;
  assetSymbol: string | null;
  /** The fork's monolithic PriceOracle. */
  oracle: string;
  /** The decoded per-asset Chainlink feed (entry point into the source graph), if any. */
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

export type CompoundV2OraclesClassifiedMap = {
  [fork: string]: { [chainId: string]: { [cToken: string]: CompoundV2OracleAssetData } };
};

type Item = { fork: string; oracle: string; asset: string; cToken: string };

/** Resolve per-asset feed addresses for one fork oracle, trying each known strategy. */
async function extractFeeds(
  chainId: string,
  oracle: string,
  assets: string[],
  symbolByAsset: Map<string, string | null>
): Promise<{ provider: string; feedByAsset: Map<string, string | null> }> {
  const feedByAsset = new Map<string, string | null>();

  // Strategy A: Venus ResilientOracle → inner ChainlinkOracle → tokenConfigs(asset).feed
  const cfgs = (await multicallRetryUniversal({
    chain: chainId,
    calls: assets.map((a) => ({ address: oracle, name: "getTokenConfig", args: [a] })),
    abi: RESILIENT_ABI as any,
    allowFailure: true,
    maxRetries: 3,
  }).catch(() => [])) as any[];
  const innerByAsset = new Map<string, string>();
  assets.forEach((a, i) => {
    const inner = toAddr(cfgs[i]?.oracles?.[0]);
    if (inner && isAddr(inner)) innerByAsset.set(a, inner);
  });
  if (innerByAsset.size > 0) {
    const entries = [...innerByAsset.entries()];
    const feeds = (await multicallRetryUniversal({
      chain: chainId,
      calls: entries.map(([a, inner]) => ({ address: inner, name: "tokenConfigs", args: [a] })),
      abi: CHAINLINK_ORACLE_ABI as any,
      allowFailure: true,
      maxRetries: 3,
    }).catch(() => [])) as any[];
    entries.forEach(([a], i) => {
      const feed = toAddr(feeds[i]?.feed);
      // Fall back to the inner oracle itself when it isn't a plain ChainlinkOracle
      // (e.g. Venus PT/correlated oracles) — probing it may still yield a pair.
      feedByAsset.set(a, isAddr(feed) ? feed : innerByAsset.get(a)!);
    });
    if ([...feedByAsset.values()].some(isAddr)) return { provider: "chainlink", feedByAsset };
  }

  // Strategy B: Moonwell ChainlinkOracle → getFeed(symbol)
  const withSym = assets.filter((a) => symbolByAsset.get(a));
  if (withSym.length > 0) {
    const feeds = (await multicallRetryUniversal({
      chain: chainId,
      calls: withSym.map((a) => ({ address: oracle, name: "getFeed", args: [symbolByAsset.get(a)!] })),
      abi: GET_FEED_ABI as any,
      allowFailure: true,
      maxRetries: 3,
    }).catch(() => [])) as any[];
    let any = false;
    withSym.forEach((a, i) => {
      const feed = toAddr(feeds[i]);
      if (isAddr(feed)) { feedByAsset.set(a, feed); any = true; }
    });
    if (any) return { provider: "chainlink", feedByAsset };
  }

  // Undecoded oracle implementation — leave feeds null.
  return { provider: "compound-v2-oracle", feedByAsset };
}

export async function classifyCompoundV2Oracles(): Promise<CompoundV2OraclesClassifiedMap> {
  const oracles = readJsonFile(oraclesFile) as Record<string, Record<string, string>>;
  const cTokens = readJsonFile(cTokensFile) as Record<string, Record<string, Record<string, string>>>;

  // Group every (fork, oracle, asset, cToken) by chain for batched probing.
  const itemsByChain = new Map<string, Item[]>();
  for (const [fork, byChain] of Object.entries(oracles)) {
    for (const [chainId, oracle] of Object.entries(byChain)) {
      if (!isAddr(oracle)) continue;
      const cmap = cTokens[fork]?.[chainId] ?? {};
      for (const [underlying, cToken] of Object.entries(cmap)) {
        if (!isAddr(cToken)) continue;
        const asset = toAddr(underlying);
        if (!asset || !isAddr(asset)) continue; // skip native (0x0) — no ERC20 feed to classify
        if (!itemsByChain.has(chainId)) itemsByChain.set(chainId, []);
        itemsByChain.get(chainId)!.push({ fork, oracle: oracle.toLowerCase(), asset, cToken: cToken.toLowerCase() });
      }
    }
  }

  const result: CompoundV2OraclesClassifiedMap = {};

  for (const [chainId, items] of itemsByChain.entries()) {
    const assets = [...new Set(items.map((i) => i.asset))];
    console.log(`Compound v2 oracles [${chainId}]: ${items.length} markets, ${assets.length} assets`);

    // Resolve asset symbols (needed for Moonwell getFeed + assess).
    const symResults = (await multicallRetryUniversal({
      chain: chainId,
      calls: assets.map((a) => ({ address: a, name: "symbol", args: [] })),
      abi: SYMBOL_ABI,
      allowFailure: true,
      maxRetries: 12,
    }).catch(() => [])) as unknown[];
    const symbolByAsset = new Map<string, string | null>();
    assets.forEach((a, i) => symbolByAsset.set(a, asString(symResults[i])));

    // Per (fork, oracle): extract per-asset feeds with the right strategy.
    const byOracle = new Map<string, Item[]>();
    for (const it of items) {
      const key = `${it.fork}|${it.oracle}`;
      if (!byOracle.has(key)) byOracle.set(key, []);
      byOracle.get(key)!.push(it);
    }

    const feedOf = new Map<string, string | null>(); // `${fork}|${asset}` -> feed
    const providerOfOracle = new Map<string, string>();
    for (const [key, group] of byOracle.entries()) {
      const [fork, oracle] = key.split("|");
      const groupAssets = [...new Set(group.map((g) => g.asset))];
      const { provider, feedByAsset } = await extractFeeds(chainId, oracle, groupAssets, symbolByAsset);
      providerOfOracle.set(key, provider);
      for (const a of groupAssets) feedOf.set(`${fork}|${a}`, feedByAsset.get(a) ?? null);
    }

    const candidateFeeds = [...new Set([...feedOf.values()].filter(isAddr))] as string[];

    // Detect Venus CorrelatedTokenOracle/OneJumpOracle among the candidate feeds.
    // These price the correlated token (the market asset) via an underlying token
    // + exchange rate, so they're a live exchange-rate oracle — not a plain feed.
    const corrRes = candidateFeeds.length
      ? ((await multicallRetryUniversal({
          chain: chainId,
          calls: candidateFeeds.flatMap((f) => [
            { address: f, name: "CORRELATED_TOKEN", args: [] },
            { address: f, name: "UNDERLYING_TOKEN", args: [] },
          ]),
          abi: CORRELATED_ABI as any,
          allowFailure: true,
          maxRetries: 3,
        }).catch(() => [])) as any[])
      : [];
    const correlated = new Map<string, { corr: string | null; under: string | null }>();
    candidateFeeds.forEach((f, i) => {
      const corr = toAddr(corrRes[2 * i]);
      const under = toAddr(corrRes[2 * i + 1]);
      if (isAddr(under)) correlated.set(f, { corr, under });
    });
    // Resolve underlying-token symbols for a transparent priceDescription.
    const underTokens = [...new Set([...correlated.values()].map((c) => c.under).filter(isAddr))] as string[];
    const underSymRes = underTokens.length
      ? ((await multicallRetryUniversal({
          chain: chainId, calls: underTokens.map((t) => ({ address: t, name: "symbol", args: [] })),
          abi: SYMBOL_ABI, allowFailure: true, maxRetries: 6,
        }).catch(() => [])) as unknown[])
      : [];
    const underSymOf = new Map<string, string | null>();
    underTokens.forEach((t, i) => underSymOf.set(t, asString(underSymRes[i])));

    // Probe only the plain (non-correlated) feeds through the source graph.
    const feeds = candidateFeeds.filter((f) => !correlated.has(f));
    const graph = feeds.length ? await probeFeedGraph(chainId, feeds) : new Map();
    const resolvedByFeed = new Map(feeds.map((f) => [f, resolveFeed(f, graph)]));

    for (const it of items) {
      const feed = feedOf.get(`${it.fork}|${it.asset}`) ?? null;
      const assetSymbol = symbolByAsset.get(it.asset) ?? null;

      if (!result[it.fork]) result[it.fork] = {};
      if (!result[it.fork][chainId]) result[it.fork][chainId] = {};

      const corr = feed && isAddr(feed) ? correlated.get(feed) : undefined;
      if (corr && feed) {
        // Exchange-rate (correlated-token) oracle. It's purpose-built for this
        // asset (CORRELATED_TOKEN == asset) and applies the asset's redemption
        // rate against the underlying's USD price → correct, not fixed-rate.
        const underSym = corr.under ? underSymOf.get(corr.under) ?? null : null;
        const forAsset = corr.corr ? corr.corr.toLowerCase() === it.asset : false;
        result[it.fork][chainId][it.cToken] = {
          cToken: it.cToken, asset: it.asset, assetSymbol,
          oracle: it.oracle, source: feed,
          rawDescription: underSym ? `Correlated price via ${underSym}` : "Correlated-token oracle",
          priceDescription: assetSymbol ? `${assetSymbol} / USD` : "UNKNOWN",
          provider: "exchange-rate",
          fixedRate: null,
          underlyingAggregator: null,
          sourcePath: [{ address: feed, description: underSym ? `via ${underSym}` : null, decimals: null, kind: "exchange-rate" }],
          denominator: "USD",
          intendedPair: assetSymbol ? `${assetSymbol} / USD` : null,
          correctOracle: forAsset && assetSymbol ? true : null,
          denominatorMatch: true,
        };
        continue;
      }

      const resolved = feed && isAddr(feed) ? resolvedByFeed.get(feed) ?? null : null;
      // Compound V2 oracles price in USD (getUnderlyingPrice is USD-scaled).
      const a = resolved
        ? assessFeed(resolved, assetSymbol, "USD")
        : { denominator: null, intendedPair: assetSymbol ? `${assetSymbol} / USD` : null, correctOracle: null, denominatorMatch: null };

      result[it.fork][chainId][it.cToken] = {
        cToken: it.cToken,
        asset: it.asset,
        assetSymbol,
        oracle: it.oracle,
        source: feed && isAddr(feed) ? feed : null,
        rawDescription: resolved?.rawDescription ?? null,
        priceDescription: resolved?.priceDescription ?? "UNKNOWN",
        provider: resolved?.provider ?? providerOfOracle.get(`${it.fork}|${it.oracle}`) ?? "compound-v2-oracle",
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
