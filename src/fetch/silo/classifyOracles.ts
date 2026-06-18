import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed, type ResolvedFeed } from "../oracle-classifier/feedResolver.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";

const siloV2File = "./data/silo-v2-markets.json";
const siloV3File = "./data/silo-v3-markets.json";

// Silo oracle adapters expose quoteToken() (the numeraire) and sometimes baseToken(),
// an inner oracle(), and a description()/name().
const SILO_ORACLE_ABI = [
  { inputs: [], name: "quoteToken", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "baseToken", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "oracle", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "description", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
];

export type SiloOracleData = {
  market: string;
  silo: string;
  side: "silo0" | "silo1";
  version: "v2" | "v3";
  token: string;
  tokenSymbol: string | null;
  solvencyOracle: string;
  maxLtvOracle: string | null;
  /** true when the solvency and maxLtv oracles are the same contract. */
  sameOracle: boolean;
  quoteToken: string | null;
  /** Numeraire the silo prices its token in. */
  numeraire: string | null;
  /** Inner price source the Silo adapter wraps, when exposed. */
  innerOracle: string | null;
  provider: string | null;
  /** Decoded reported pair from the wrapped feed; "UNKNOWN" when not exposed on-chain. */
  priceDescription: string;
  underlyingAggregator: string | null;
  sourcePath: Array<{ address: string; description: string | null; decimals: number | null; kind: string }>;
  /** Configured pair from the market/oracle metadata, "<tokenSym> / <numeraire>". */
  configuredPair: string | null;
  intendedPair: string | null;
  correctOracle: true | false | null;
  denominatorMatch: true | false | null;
};

export type SiloOraclesClassifiedMap = {
  [chainId: string]: { [silo: string]: SiloOracleData };
};

type SideRaw = {
  silo?: string;
  token?: string;
  symbol?: string;
  solvencyOracle?: string;
  maxLtvOracle?: string;
};
type MarketRaw = { name?: string; silo0?: SideRaw; silo1?: SideRaw };

type SideItem = {
  market: string;
  silo: string;
  side: "silo0" | "silo1";
  version: "v2" | "v3";
  token: string;
  tokenSymbol: string | null;
  solvencyOracle: string;
  maxLtvOracle: string | null;
};

function collectSides(
  markets: Record<string, MarketRaw[]>,
  version: "v2" | "v3",
  out: Map<string, SideItem[]>
) {
  for (const [chainId, list] of Object.entries(markets)) {
    for (const m of list ?? []) {
      for (const side of ["silo0", "silo1"] as const) {
        const s = m[side];
        const oracle = toAddr(s?.solvencyOracle);
        const silo = toAddr(s?.silo);
        const token = toAddr(s?.token);
        if (!oracle || !silo || !token) continue;
        if (!out.has(chainId)) out.set(chainId, []);
        out.get(chainId)!.push({
          market: m.name ?? silo,
          silo,
          side,
          version,
          token,
          tokenSymbol: s?.symbol ?? null,
          solvencyOracle: oracle,
          maxLtvOracle: toAddr(s?.maxLtvOracle),
        });
      }
    }
  }
}

export async function classifySiloOracles(): Promise<SiloOraclesClassifiedMap> {
  const v2 = (() => {
    try {
      return readJsonFile(siloV2File);
    } catch {
      return {};
    }
  })() as Record<string, MarketRaw[]>;
  const v3 = (() => {
    try {
      return readJsonFile(siloV3File);
    } catch {
      return {};
    }
  })() as Record<string, MarketRaw[]>;

  const sidesByChain = new Map<string, SideItem[]>();
  collectSides(v2, "v2", sidesByChain);
  collectSides(v3, "v3", sidesByChain);

  const result: SiloOraclesClassifiedMap = {};

  for (const [chainId, sides] of sidesByChain.entries()) {
    console.log(`Silo oracles [${chainId}]: ${sides.length} silos`);

    const oracles = [...new Set(sides.map((s) => s.solvencyOracle))];

    // 1. probe each solvency oracle for quoteToken / baseToken / inner oracle / description
    const probe = (await multicallRetryUniversal({
      chain: chainId,
      calls: oracles.flatMap((o) => [
        { address: o, name: "quoteToken", args: [] },
        { address: o, name: "baseToken", args: [] },
        { address: o, name: "oracle", args: [] },
        { address: o, name: "description", args: [] },
        { address: o, name: "name", args: [] },
      ]),
      abi: SILO_ORACLE_ABI,
      allowFailure: true,
      maxRetries: 12,
    })) as unknown[];

    type OracleProbe = {
      quoteToken: string | null;
      inner: string | null;
      description: string | null;
      name: string | null;
    };
    const probeByOracle = new Map<string, OracleProbe>();
    oracles.forEach((o, i) => {
      probeByOracle.set(o, {
        quoteToken: toAddr(probe[5 * i]),
        inner: toAddr(probe[5 * i + 2]),
        description: asString(probe[5 * i + 3]),
        name: asString(probe[5 * i + 4]),
      });
    });

    // 2. decode the wrapped feed graph (the solvency oracle itself + any inner oracle)
    const feedEntries = [
      ...new Set(
        oracles.flatMap((o) => {
          const p = probeByOracle.get(o)!;
          return [o, p.inner].filter((x): x is string => !!x);
        })
      ),
    ];
    const feedGraph = await probeFeedGraph(chainId, feedEntries);

    // 3. resolve quoteToken symbols (token symbols come from the market metadata)
    const quoteTokens = [
      ...new Set(
        [...probeByOracle.values()].map((p) => p.quoteToken).filter((q): q is string => !!q)
      ),
    ];
    const quoteSymbols = new Map<string, string | null>();
    if (quoteTokens.length > 0) {
      const qres = (await multicallRetryUniversal({
        chain: chainId,
        calls: quoteTokens.map((q) => ({ address: q, name: "symbol", args: [] })),
        abi: SYMBOL_ABI,
        allowFailure: true,
        maxRetries: 12,
      })) as unknown[];
      quoteTokens.forEach((q, i) => quoteSymbols.set(q, asString(qres[i])));
    }

    result[chainId] = {};
    for (const s of sides) {
      const p = probeByOracle.get(s.solvencyOracle)!;
      const numeraire = p.quoteToken ? quoteSymbols.get(p.quoteToken) ?? null : null;

      // Prefer decoding the inner oracle, fall back to the solvency oracle itself.
      const feedEntry = p.inner ?? s.solvencyOracle;
      const resolved: ResolvedFeed = resolveFeed(feedEntry, feedGraph);

      const provider =
        p.name ?? p.description ?? (resolved.provider !== "unknown" ? resolved.provider : "silo-oracle");
      const configuredPair =
        s.tokenSymbol && numeraire ? `${s.tokenSymbol} / ${numeraire}` : null;

      const { intendedPair, correctOracle, denominatorMatch } = assessFeed(
        resolved,
        s.tokenSymbol,
        numeraire
      );

      result[chainId][s.silo] = {
        market: s.market,
        silo: s.silo,
        side: s.side,
        version: s.version,
        token: s.token,
        tokenSymbol: s.tokenSymbol,
        solvencyOracle: s.solvencyOracle,
        maxLtvOracle: s.maxLtvOracle,
        sameOracle: s.maxLtvOracle === s.solvencyOracle,
        quoteToken: p.quoteToken,
        numeraire,
        innerOracle: p.inner,
        provider,
        priceDescription: resolved.priceDescription,
        underlyingAggregator: resolved.underlyingAggregator,
        sourcePath: resolved.sourcePath,
        configuredPair,
        intendedPair: intendedPair ?? configuredPair,
        correctOracle,
        denominatorMatch,
      };
    }
  }

  return result;
}
