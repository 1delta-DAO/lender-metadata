import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, symbolsMatch, toAddr } from "../oracle-classifier/normalize.js";

const eulerVaultsFile = "./data/euler-vaults.json";

/** Euler uses address(840) (ISO-4217 USD) as the unit-of-account sentinel for USD. */
const USD_SENTINEL = "0x0000000000000000000000000000000000000348";

const VAULT_ABI = [
  { inputs: [], name: "oracle", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "unitOfAccount", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "asset", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
];

const ROUTER_ABI = [
  {
    inputs: [{ type: "address" }, { type: "address" }],
    name: "getConfiguredOracle",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
];

// Euler oracle adapters expose name() plus base()/quote() (the end-to-end pair),
// feed() for terminal Chainlink/Pyth/Redstone adapters, and cross() for CrossAdapters.
const ADAPTER_ABI = [
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "base", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "quote", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "feed", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "cross", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
];

export type EulerOracleVaultData = {
  vault: string;
  vaultSymbol: string | null;
  asset: string;
  assetSymbol: string | null;
  router: string;
  /** Configured oracle adapter for (asset, unitOfAccount). */
  adapter: string | null;
  /** Adapter contract name() — the provider/type (ChainlinkOracle, PythOracle, CrossAdapter, ...). */
  provider: string | null;
  unitOfAccount: string;
  numeraire: string | null;
  base: string | null;
  baseSymbol: string | null;
  quote: string | null;
  quoteSymbol: string | null;
  /** Cross/intermediate token for CrossAdapters. */
  cross: string | null;
  crossSymbol: string | null;
  /** Reported end-to-end pair, "<baseSym> / <quoteSym>". */
  priceDescription: string;
  /** Terminal price feed (Chainlink aggregator) behind the adapter, if any. */
  feed: string | null;
  feedDescription: string | null;
  fixedRate: true | null;
  intendedPair: string | null;
  correctOracle: true | false | null;
  denominatorMatch: true | false | null;
};

export type EulerOraclesClassifiedMap = {
  [chainId: string]: { [vault: string]: EulerOracleVaultData };
};

function numeraireSymbol(
  uoa: string,
  symbols: Map<string, string | null>
): string | null {
  if (uoa.toLowerCase() === USD_SENTINEL) return "USD";
  return symbols.get(uoa.toLowerCase()) ?? null;
}

export async function classifyEulerOracles(): Promise<EulerOraclesClassifiedMap> {
  const eulerVaults = readJsonFile(eulerVaultsFile) as Record<
    string,
    Record<string, Array<{ underlying: string; vault: string }>>
  >;

  // flatten EULER_V2 (and any other forks) into chain -> vault list
  const byChain = new Map<string, string[]>();
  for (const byChainMap of Object.values(eulerVaults)) {
    for (const [chainId, list] of Object.entries(byChainMap)) {
      if (!byChain.has(chainId)) byChain.set(chainId, []);
      for (const v of list) byChain.get(chainId)!.push(v.vault.toLowerCase());
    }
  }

  const result: EulerOraclesClassifiedMap = {};

  for (const [chainId, vaultsRaw] of byChain.entries()) {
    const vaults = [...new Set(vaultsRaw)];
    console.log(`Euler oracles [${chainId}]: ${vaults.length} vaults`);

    // 1. vault -> oracle(router), unitOfAccount, asset, symbol
    const vaultRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: vaults.flatMap((v) => [
        { address: v, name: "oracle", args: [] },
        { address: v, name: "unitOfAccount", args: [] },
        { address: v, name: "asset", args: [] },
        { address: v, name: "symbol", args: [] },
      ]),
      abi: VAULT_ABI,
      allowFailure: true,
      maxRetries: 12,
    })) as unknown[];

    type VaultInfo = {
      vault: string;
      router: string;
      uoa: string;
      asset: string;
      symbol: string | null;
    };
    const infos: VaultInfo[] = [];
    vaults.forEach((vault, i) => {
      const router = toAddr(vaultRes[4 * i]);
      const uoa = vaultRes[4 * i + 1];
      const asset = toAddr(vaultRes[4 * i + 2]);
      const symbol = asString(vaultRes[4 * i + 3]);
      // escrow / uninitialized vaults have no router or unit of account
      if (!router || !asset || typeof uoa !== "string") return;
      infos.push({ vault, router, uoa: (uoa as string).toLowerCase(), asset, symbol });
    });
    if (infos.length === 0) continue;

    // 2. configured adapter per (router, asset, uoa); router name() for context
    const triplets = [
      ...new Map(
        infos.map((it) => [`${it.router}|${it.asset}|${it.uoa}`, it])
      ).values(),
    ];
    const adapterRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: triplets.map((t) => ({
        address: t.router,
        name: "getConfiguredOracle",
        args: [t.asset, t.uoa],
      })),
      abi: ROUTER_ABI,
      allowFailure: true,
      maxRetries: 12,
    })) as unknown[];
    const adapterByTriplet = new Map<string, string | null>();
    triplets.forEach((t, i) =>
      adapterByTriplet.set(`${t.router}|${t.asset}|${t.uoa}`, toAddr(adapterRes[i]))
    );

    // 3. adapter details
    const adapters = [
      ...new Set(
        [...adapterByTriplet.values()].filter((a): a is string => !!a)
      ),
    ];
    const adapterDetailRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: adapters.flatMap((a) => [
        { address: a, name: "name", args: [] },
        { address: a, name: "base", args: [] },
        { address: a, name: "quote", args: [] },
        { address: a, name: "feed", args: [] },
        { address: a, name: "cross", args: [] },
      ]),
      abi: ADAPTER_ABI,
      allowFailure: true,
      maxRetries: 12,
    })) as unknown[];
    type AdapterInfo = {
      name: string | null;
      base: string | null;
      quote: string | null;
      feed: string | null;
      cross: string | null;
    };
    const adapterInfo = new Map<string, AdapterInfo>();
    adapters.forEach((a, i) => {
      adapterInfo.set(a, {
        name: asString(adapterDetailRes[5 * i]),
        base: toAddr(adapterDetailRes[5 * i + 1]),
        quote: toAddr(adapterDetailRes[5 * i + 2]),
        feed: toAddr(adapterDetailRes[5 * i + 3]),
        cross: toAddr(adapterDetailRes[5 * i + 4]),
      });
    });

    // 4. resolve symbols (assets, unit-of-account tokens, adapter base/quote/cross)
    const symAddrs = new Set<string>();
    for (const it of infos) {
      symAddrs.add(it.asset);
      if (it.uoa !== USD_SENTINEL) symAddrs.add(it.uoa);
    }
    for (const a of adapterInfo.values()) {
      for (const x of [a.base, a.quote, a.cross]) if (x) symAddrs.add(x);
    }
    const symList = [...symAddrs];
    const symRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: symList.map((a) => ({ address: a, name: "symbol", args: [] })),
      abi: SYMBOL_ABI,
      allowFailure: true,
      maxRetries: 12,
    })) as unknown[];
    const symbols = new Map<string, string | null>();
    symList.forEach((a, i) => symbols.set(a, asString(symRes[i])));
    const symOf = (addr: string | null): string | null => {
      if (!addr) return null;
      if (addr.toLowerCase() === USD_SENTINEL) return "USD";
      return symbols.get(addr.toLowerCase()) ?? null;
    };

    // 5. resolve terminal feed descriptions (Chainlink aggregators behind adapters)
    const feeds = [
      ...new Set([...adapterInfo.values()].map((a) => a.feed).filter((f): f is string => !!f)),
    ];
    const feedGraph = await probeFeedGraph(chainId, feeds);

    // 6. build per-vault entries
    result[chainId] = {};
    for (const it of infos) {
      const adapter = adapterByTriplet.get(`${it.router}|${it.asset}|${it.uoa}`) ?? null;
      const ai = adapter ? adapterInfo.get(adapter) : undefined;
      const numeraire = numeraireSymbol(it.uoa, symbols);
      const baseSymbol = symOf(ai?.base ?? null);
      const quoteSymbol = symOf(ai?.quote ?? null);
      const crossSymbol = symOf(ai?.cross ?? null);
      const provider = ai?.name ?? null;
      const isFixed = !!provider && /fixedrate/i.test(provider);

      const feedDescription =
        ai?.feed ? resolveFeed(ai.feed, feedGraph).priceDescription : null;

      const priceDescription =
        baseSymbol && quoteSymbol
          ? `${baseSymbol} / ${quoteSymbol}`
          : feedDescription && feedDescription !== "UNKNOWN"
            ? feedDescription
            : "UNKNOWN";

      const assetSymbol = symOf(it.asset);
      const intendedPair =
        assetSymbol && numeraire ? `${assetSymbol} / ${numeraire}` : null;

      // correctOracle: does the adapter price the intended asset? (base match)
      // denominatorMatch: is it denominated in the vault's unit of account? (quote match)
      const verifiable = !isFixed && !!adapter && !!baseSymbol && !!quoteSymbol;
      const correctOracle: true | false | null =
        verifiable && assetSymbol ? symbolsMatch(baseSymbol!, assetSymbol) : null;
      const denominatorMatch: true | false | null =
        verifiable && numeraire ? symbolsMatch(quoteSymbol!, numeraire) : null;

      result[chainId][it.vault] = {
        vault: it.vault,
        vaultSymbol: it.symbol,
        asset: it.asset,
        assetSymbol,
        router: it.router,
        adapter,
        provider,
        unitOfAccount: it.uoa,
        numeraire,
        base: ai?.base ?? null,
        baseSymbol,
        quote: ai?.quote ?? null,
        quoteSymbol,
        cross: ai?.cross ?? null,
        crossSymbol,
        priceDescription,
        feed: ai?.feed ?? null,
        feedDescription,
        fixedRate: isFixed ? true : null,
        intendedPair,
        correctOracle,
        denominatorMatch,
      };
    }
  }

  return result;
}
