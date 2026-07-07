import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import {
  probeFeedGraph,
  resolveFeed,
  type ResolvedFeed,
} from "../oracle-classifier/feedResolver.js";
import { asString, parsePair, toAddr, ZERO_ADDRESS } from "../oracle-classifier/normalize.js";
import { assessFeed, dominantDenominator } from "../oracle-classifier/assess.js";

const aaveOraclesFile = "./data/aave-oracles.json";
const aaveReservesFile = "./data/aave-reserves.json";
const aaveV4SourcesFile = "./data/aave-v4-oracle-sources.json";

/** AaveOracle: per-asset Chainlink-style price source + the market's unit of account. */
const AAVE_ORACLE_ABI = [
  {
    inputs: [{ internalType: "address", name: "asset", type: "address" }],
    name: "getSourceOfAsset",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "BASE_CURRENCY",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

export type AaveOracleAssetData = {
  asset: string;
  assetSymbol: string | null;
  /** AaveOracle price source for this asset (a Chainlink-style aggregator/adapter). */
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

export type AaveOraclesClassifiedMap = {
  [fork: string]: { [chainId: string]: { [asset: string]: AaveOracleAssetData } };
};

export type AaveV4OraclesClassifiedMap = {
  [chainId: string]: { [underlying: string]: AaveOracleAssetData };
};

async function resolveSymbols(
  chainId: string,
  addresses: string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (addresses.length === 0) return map;
  const res = (await multicallRetryUniversal({
    chain: chainId,
    calls: addresses.map((a) => ({ address: a, name: "symbol", args: [] })),
    abi: SYMBOL_ABI,
    allowFailure: true,
    maxRetries: 12,
  })) as unknown[];
  addresses.forEach((a, i) => map.set(a, asString(res[i])));
  return map;
}

function buildEntry(
  asset: string,
  assetSymbol: string | null,
  source: string | null,
  resolved: ResolvedFeed | null,
  numeraire: string | null
): AaveOracleAssetData {
  if (!source || !resolved) {
    return {
      asset,
      assetSymbol,
      source: source ?? null,
      rawDescription: resolved?.rawDescription ?? null,
      priceDescription: resolved?.priceDescription ?? "UNKNOWN",
      provider: resolved?.provider ?? "unknown",
      fixedRate: resolved?.fixedRate ?? null,
      underlyingAggregator: resolved?.underlyingAggregator ?? null,
      sourcePath: resolved?.sourcePath ?? [],
      denominator: null,
      intendedPair: assetSymbol && numeraire ? `${assetSymbol} / ${numeraire}` : null,
      correctOracle: null,
      denominatorMatch: null,
    };
  }
  const { denominator, intendedPair, correctOracle, denominatorMatch } = assessFeed(
    resolved,
    assetSymbol,
    numeraire
  );
  return {
    asset,
    assetSymbol,
    source,
    rawDescription: resolved.rawDescription,
    priceDescription: resolved.priceDescription,
    provider: resolved.provider,
    fixedRate: resolved.fixedRate,
    underlyingAggregator: resolved.underlyingAggregator,
    sourcePath: resolved.sourcePath,
    denominator,
    intendedPair,
    correctOracle,
    denominatorMatch,
  };
}

/** Derives a market's numeraire: a real BASE_CURRENCY token, else the dominant feed denominator. */
function deriveNumeraire(
  baseCurrencySymbol: string | null,
  resolvedFeeds: (ResolvedFeed | null)[]
): string {
  if (baseCurrencySymbol) return baseCurrencySymbol;
  const denoms = resolvedFeeds.map((r) =>
    r ? parsePair(r.priceDescription)?.quote ?? null : null
  );
  return dominantDenominator(denoms) ?? "USD";
}

/** Classify Aave v2/v3 markets: AaveOracle.getSourceOfAsset() per reserve. */
export async function classifyAaveOracles(): Promise<AaveOraclesClassifiedMap> {
  const oracles = readJsonFile(aaveOraclesFile) as Record<string, Record<string, string>>;
  const reserves = readJsonFile(aaveReservesFile) as Record<
    string,
    Record<string, string[]>
  >;

  const result: AaveOraclesClassifiedMap = {};

  // Optional comma-separated chain-id allowlist (e.g. AAVE_CHAIN_FILTER=1672)
  // to reclassify a single chain's oracles. Empty = all chains. Callers that
  // scope this way must merge the (partial) result into the existing classified
  // file rather than replacing it, or other chains would be dropped.
  const chainFilter = new Set(
    (process.env.AAVE_CHAIN_FILTER ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  for (const [fork, byChain] of Object.entries(oracles)) {
    for (const [chainId, oracleAddrRaw] of Object.entries(byChain)) {
      if (chainFilter.size && !chainFilter.has(chainId)) continue;
      const oracleAddr = toAddr(oracleAddrRaw);
      const assets = (reserves[fork]?.[chainId] ?? []).map((a) => a.toLowerCase());
      if (!oracleAddr || assets.length === 0) continue;

      console.log(`Aave oracles [${fork} ${chainId}]: ${assets.length} reserves`);

      // 1. base currency (numeraire) + per-asset price sources
      let baseCurrency: string | null = null;
      try {
        const [bc] = (await multicallRetryUniversal({
          chain: chainId,
          calls: [{ address: oracleAddr, name: "BASE_CURRENCY", args: [] }],
          abi: AAVE_ORACLE_ABI,
          allowFailure: true,
          maxRetries: 8,
        })) as unknown[];
        baseCurrency = toAddr(bc);
      } catch {}

      const sourceResults = (await multicallRetryUniversal({
        chain: chainId,
        calls: assets.map((a) => ({
          address: oracleAddr,
          name: "getSourceOfAsset",
          args: [a],
        })),
        abi: AAVE_ORACLE_ABI,
        allowFailure: true,
        maxRetries: 12,
      })) as unknown[];

      const sourceByAsset = new Map<string, string | null>();
      assets.forEach((a, i) => sourceByAsset.set(a, toAddr(sourceResults[i])));

      // 2. walk source graph + resolve symbols (assets + base currency token)
      const sources = [...new Set([...sourceByAsset.values()].filter((s): s is string => !!s))];
      const graph = await probeFeedGraph(chainId, sources);

      const symAddrs = [...assets];
      // BASE_CURRENCY == 0x0 (v3) is the USD sentinel; a non-zero token is the real numeraire.
      const baseCurrencyToken =
        baseCurrency && baseCurrency !== ZERO_ADDRESS ? baseCurrency : null;
      if (baseCurrencyToken) symAddrs.push(baseCurrencyToken);
      const symbols = await resolveSymbols(chainId, symAddrs);

      // Resolve every feed first so the numeraire can fall back to the dominant
      // denominator (legacy V2 markets are ETH-denominated but expose no BASE_CURRENCY).
      const resolvedByAsset = new Map<string, ResolvedFeed | null>();
      for (const asset of assets) {
        const src = sourceByAsset.get(asset);
        resolvedByAsset.set(asset, src ? resolveFeed(src, graph) : null);
      }
      const numeraire = deriveNumeraire(
        baseCurrencyToken ? symbols.get(baseCurrencyToken) ?? null : null,
        [...resolvedByAsset.values()]
      );

      if (!result[fork]) result[fork] = {};
      result[fork][chainId] = {};
      for (const asset of assets) {
        result[fork][chainId][asset] = buildEntry(
          asset,
          symbols.get(asset) ?? null,
          sourceByAsset.get(asset) ?? null,
          resolvedByAsset.get(asset) ?? null,
          numeraire
        );
      }
    }
  }

  return result;
}

/** Classify Aave v4 markets from the already-decoded per-underlying `source` feeds. */
export async function classifyAaveV4Oracles(): Promise<AaveV4OraclesClassifiedMap> {
  const sourcesByChain = readJsonFile(aaveV4SourcesFile) as Record<
    string,
    Array<{ underlying: string; source: string; oracle?: string; spoke?: string }>
  >;

  const result: AaveV4OraclesClassifiedMap = {};

  for (const [chainId, entries] of Object.entries(sourcesByChain)) {
    if (!entries?.length) continue;
    console.log(`Aave v4 oracles [${chainId}]: ${entries.length} reserve sources`);

    const sources = [
      ...new Set(entries.map((e) => toAddr(e.source)).filter((s): s is string => !!s)),
    ];
    const graph = await probeFeedGraph(chainId, sources);
    const underlyings = [...new Set(entries.map((e) => e.underlying.toLowerCase()))];
    const symbols = await resolveSymbols(chainId, underlyings);

    // Resolve feeds first to derive the numeraire from the dominant denominator.
    const resolvedBySource = new Map<string, ResolvedFeed | null>();
    for (const e of entries) {
      const src = toAddr(e.source);
      if (src && !resolvedBySource.has(src))
        resolvedBySource.set(src, resolveFeed(src, graph));
    }
    const numeraire = deriveNumeraire(null, [...resolvedBySource.values()]);

    result[chainId] = {};
    for (const e of entries) {
      const underlying = e.underlying.toLowerCase();
      const src = toAddr(e.source);
      const entry = buildEntry(
        underlying,
        symbols.get(underlying) ?? null,
        src,
        src ? resolvedBySource.get(src) ?? null : null,
        numeraire
      );
      const existing = result[chainId][underlying];
      // Same underlying can appear across spokes; keep, but disambiguate on conflict.
      if (existing && existing.source !== entry.source) {
        result[chainId][`${underlying}@${(e.spoke ?? "").toLowerCase()}`] = entry;
      } else {
        result[chainId][underlying] = entry;
      }
    }
  }

  return result;
}
