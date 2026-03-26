import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import {
  MORPHO_CHAINLINK_ORACLE_V2_ABI,
  CURRENT_ORACLE_ABI,
  FEED_DESCRIPTION_ABI,
  REDSTONE_DATA_FEED_ID_ABI,
  VAULT_SYMBOL_ABI,
  VAULT_ASSET_ABI,
  VAULT_ACCOUNTING_ASSET_ABI,
} from "./oracleAbi.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const morphoOraclesFile = "./data/morpho-oracles.json";
const morphoTypeOraclesFile = "./data/morpho-type-oracles.json";

type OracleConfig = {
  baseFeed1: string | null;
  baseFeed2: string | null;
  quoteFeed1: string | null;
  quoteFeed2: string | null;
  baseVault: string | null;
  quoteVault: string | null;
};

type OracleData = OracleConfig & {
  underlyingOracle: string | null;
  baseFeed1Description: string | null;
  baseFeed2Description: string | null;
  quoteFeed1Description: string | null;
  quoteFeed2Description: string | null;
  baseVaultDescription: string | null;
  baseVaultUnderlying: string | null;
  quoteVaultDescription: string | null;
  quoteVaultUnderlying: string | null;
  priceDescription: string;
  /** true when oracle has no feeds/vaults/underlying — indicating a hardcoded static price. null when unknown. */
  fixedRate: true | null;
};

export type MorphoOraclesDataMap = {
  [chainId: string]: {
    [oracle: string]: OracleData;
  };
};

const VALID_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function isValidNonZeroAddress(addr: unknown): addr is string {
  return (
    typeof addr === "string" &&
    VALID_ADDRESS_RE.test(addr) &&
    addr.toLowerCase() !== ZERO_ADDRESS
  );
}

function toAddr(v: string | null | undefined): string | null {
  return isValidNonZeroAddress(v) ? v.toLowerCase() : null;
}

function hasNoSignals(config: OracleConfig): boolean {
  return (
    config.baseFeed1 === null &&
    config.baseFeed2 === null &&
    config.quoteFeed1 === null &&
    config.quoteFeed2 === null &&
    config.baseVault === null &&
    config.quoteVault === null
  );
}

/**
 * Synthesizes a human-readable "collateral / loan" description from feed and vault data.
 *
 * The Morpho price formula is:
 *   price = SCALE × (baseVaultRate × baseFeed1 × baseFeed2) / (quoteVaultRate × quoteFeed1 × quoteFeed2)
 *
 * where each Chainlink feed "A / B" has the VALUE B/A (e.g. "ETH / USD" returns USD per ETH).
 * Each vault rate = convertToAssets(sample)/sample = underlying per share.
 *
 * To find the effective "collateral / loan" pair we track all tokens in numerator and denominator,
 * then cancel matching intermediates:
 *
 *   price_numerator_tokens   = [bVaultSym, bFeed1.A, bFeed2.A, qFeed1.B, qFeed2.B]
 *   price_denominator_tokens = [bVaultUnderlying, bFeed1.B, bFeed2.B, qFeed1.A, qFeed2.A, qVaultSym]
 *
 * The vault contributes (vaultSymbol → num, vaultUnderlying → denom) for base vault — this lets the
 * underlying token cancel with the matching base feed (e.g. yvvbUSDT↔USDT).
 * For quote vault the contribution is inverted: (underlying → num, vaultSymbol → denom).
 */
function synthesizePriceDescription(
  b1Desc: string | null,
  b2Desc: string | null,
  q1Desc: string | null,
  q2Desc: string | null,
  baseVaultSymbol: string | null,
  baseVaultUnderlying: string | null,
  quoteVaultSymbol: string | null,
  quoteVaultUnderlying: string | null
): string {
  const parseFeed = (desc: string | null): { A: string; B: string } | null => {
    if (!desc) return null;
    // Support both "A / B" (standard Chainlink) and "A/B" (no spaces)
    const parts = desc.split(/\s*\/\s*/);
    if (parts.length < 2) return null;
    const A = parts[0].trim();
    const B = parts[1].trim();
    if (!A || !B) return null;
    return { A, B };
  };

  const basePairs = [parseFeed(b1Desc), parseFeed(b2Desc)].filter(
    (p): p is { A: string; B: string } => p !== null
  );
  const quotePairs = [parseFeed(q1Desc), parseFeed(q2Desc)].filter(
    (p): p is { A: string; B: string } => p !== null
  );

  // price numerator tokens
  const numTokens: string[] = [
    // base vault: vaultSymbol is the collateral (numerator anchor)
    ...(baseVaultSymbol ? [baseVaultSymbol] : []),
    // base feeds: A tokens go to numerator
    ...basePairs.map((p) => p.A),
    // quote feeds: B tokens go to numerator (quote feeds are inverted in the price formula)
    ...quotePairs.map((p) => p.B),
    // quote vault: underlying goes to numerator (inverted, cancels with quote feeds)
    ...(quoteVaultUnderlying ? [quoteVaultUnderlying] : []),
  ];

  // price denominator tokens
  const denomTokens: string[] = [
    // base vault: underlying goes to denominator so it can cancel with base feeds
    ...(baseVaultUnderlying ? [baseVaultUnderlying] : []),
    // base feeds: B tokens go to denominator
    ...basePairs.map((p) => p.B),
    // quote feeds: A tokens go to denominator
    ...quotePairs.map((p) => p.A),
    // quote vault: vaultSymbol is the loan token (denominator anchor)
    ...(quoteVaultSymbol ? [quoteVaultSymbol] : []),
  ];

  if (numTokens.length === 0 && denomTokens.length === 0) return "UNKNOWN";

  // Cancel matching intermediate tokens
  const nums = [...numTokens];
  const denoms = [...denomTokens];
  for (const token of numTokens) {
    const di = denoms.indexOf(token);
    if (di !== -1) {
      nums.splice(nums.indexOf(token), 1);
      denoms.splice(di, 1);
    }
  }

  if (nums.length === 0 && denoms.length === 0) return "UNKNOWN";
  const numerator = nums.join(" * ") || "1";
  const denominator = denoms.join(" * ") || "1";
  return `${numerator} / ${denominator}`;
}

/**
 * Decodes a bytes32 hex string (e.g. "0x4254430000...") to a UTF-8 string by
 * stripping trailing null bytes. Returns null if the result is empty.
 */
function decodeBytes32String(hex: unknown): string | null {
  if (typeof hex !== "string" || hex === "0x" || hex.length < 4) return null;
  const bytes = Buffer.from(hex.slice(2).padEnd(64, "0"), "hex");
  const nullIdx = bytes.indexOf(0);
  const str = bytes.subarray(0, nullIdx >= 0 ? nullIdx : bytes.length).toString("utf8");
  return str.length > 0 ? str : null;
}

/**
 * Normalizes RedStone feed descriptions to standard "A / B" format.
 * RedStone feeds use descriptions like "RedStone Price Feed for X" (implying X/USD)
 * or "RedStone Price Feed for X/Y" (explicit pair).
 */
function normalizeRedStoneDescription(desc: string): string {
  // Strip known non-standard prefixes
  const stripped = desc.replace(/^Ojo Yield Risk Engine\s+/i, "");

  const match = stripped.match(/^RedStone Price Feed for (.+)$/i);
  if (!match) return desc;

  let content = match[1].trim();

  if (content.includes("/")) {
    const idx = content.indexOf("/");
    const base = content
      .slice(0, idx)
      .replace(/_(MAIN_)?FUNDAMENTAL$/, "")
      .replace(/_V\d+$/, "")
      .trim();
    const quote = content.slice(idx + 1).trim() || "USD";
    return `${base} / ${quote}`;
  }

  const token = content
    .replace(/_(MAIN_)?FUNDAMENTAL$/, "")
    .replace(/_V\d+$/, "")
    .trim();
  return `${token} / USD`;
}

/**
 * Extracts a clean "A / B" pair from any oracle description containing a "/".
 * Takes the last word before the slash (handles "Ojo Yield Risk Engine sToken / ...")
 * and the first word after the slash (handles "... exchange rate adapter" suffixes).
 * Returns the description unchanged if no slash is present.
 */
function normalizeGenericDescription(desc: string): string {
  // Case 1: has "/" — last word before "/" and first word after "/"
  if (desc.includes("/")) {
    const idx = desc.indexOf("/");
    const A = desc.slice(0, idx).trim().split(/\s+/).pop()?.trim();
    const B = desc.slice(idx + 1).trim().split(/\s+/)[0]?.trim();
    if (A && B) return `${A} / ${B}`;
  }

  // Case 2: "TokenA-TokenB Exchange Rate" — split on last hyphen before "Exchange Rate"
  const erMatch = desc.match(/^(.+?)\s+[Ee]xchange\s+[Rr]ate$/i);
  if (erMatch) {
    const pair = erMatch[1].trim();
    const lastHyphen = pair.lastIndexOf("-");
    if (lastHyphen > 0) {
      const A = pair.slice(0, lastHyphen).trim();
      const B = pair.slice(lastHyphen + 1).trim();
      // Only accept single-word tokens (no spaces)
      if (A && B && !A.includes(" ") && !B.includes(" ")) return `${A} / ${B}`;
    }
  }

  return desc;
}

// A raw result is a successful V2 call if it's a 42-char hex address (zero or non-zero).
// A failed call returns "0x" (2 chars). Checking any of the 6 results confirms V2 compliance.
function isV2Result(raw: string | null): boolean {
  return typeof raw === "string" && raw.length === 42;
}

// Fetch BASE_FEED_1/2, QUOTE_FEED_1/2, BASE_VAULT, QUOTE_VAULT for a list of oracle addresses.
// Also returns isV2 per oracle: true if any selector responded (even with address zero).
async function fetchOracleConfigs(
  chainId: string,
  oracles: string[]
): Promise<{ configs: Record<string, OracleConfig>; isV2Map: Record<string, boolean> }> {
  const calls = oracles.flatMap((oracle) => [
    { address: oracle, name: "BASE_FEED_1", args: [] },
    { address: oracle, name: "BASE_FEED_2", args: [] },
    { address: oracle, name: "QUOTE_FEED_1", args: [] },
    { address: oracle, name: "QUOTE_FEED_2", args: [] },
    { address: oracle, name: "BASE_VAULT", args: [] },
    { address: oracle, name: "QUOTE_VAULT", args: [] },
  ]);

  const results = (await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: MORPHO_CHAINLINK_ORACLE_V2_ABI,
    allowFailure: true,
    maxRetries: 12,
  })) as (string | null)[];

  const configs: Record<string, OracleConfig> = {};
  const isV2Map: Record<string, boolean> = {};
  for (let i = 0; i < oracles.length; i++) {
    const s = results.slice(6 * i, 6 * i + 6);
    configs[oracles[i]] = {
      baseFeed1: toAddr(s[0]),
      baseFeed2: toAddr(s[1]),
      quoteFeed1: toAddr(s[2]),
      quoteFeed2: toAddr(s[3]),
      baseVault: toAddr(s[4]),
      quoteVault: toAddr(s[5]),
    };
    // Oracle is V2-compatible if at least one selector returned a proper address
    isV2Map[oracles[i]] = s.some(isV2Result);
  }
  return { configs, isV2Map };
}

export async function fetchMorphoOracleData(): Promise<MorphoOraclesDataMap> {
  const [morphoOracles, morphoTypeOracles] = await Promise.all([
    readJsonFile(morphoOraclesFile),
    readJsonFile(morphoTypeOraclesFile),
  ]);

  const oraclesPerChain: Record<string, Set<string>> = {};

  for (const [chainId, entries] of Object.entries(
    morphoOracles as Record<string, any[]>
  )) {
    if (!oraclesPerChain[chainId]) oraclesPerChain[chainId] = new Set();
    for (const entry of entries) {
      if (isValidNonZeroAddress(entry.oracle))
        oraclesPerChain[chainId].add(entry.oracle.toLowerCase());
    }
  }

  for (const [chainId, forks] of Object.entries(
    morphoTypeOracles as Record<string, Record<string, any[]>>
  )) {
    if (!oraclesPerChain[chainId]) oraclesPerChain[chainId] = new Set();
    for (const entries of Object.values(forks)) {
      for (const entry of entries) {
        if (isValidNonZeroAddress(entry.oracle))
          oraclesPerChain[chainId].add(entry.oracle.toLowerCase());
      }
    }
  }

  const result: MorphoOraclesDataMap = {};

  for (const [chainId, oracleSet] of Object.entries(oraclesPerChain)) {
    const oracles = Array.from(oracleSet);
    if (oracles.length === 0) continue;

    console.log(`Morpho oracles [${chainId}]: fetching ${oracles.length} oracle configs`);

    // Batch 1: feed + vault addresses for all oracles
    const { configs: oracleConfigs, isV2Map } = await fetchOracleConfigs(chainId, oracles);

    // Batch 2: resolve wrapper oracles (no feeds/vaults) via currentOracle()
    const noSignalOracles = oracles.filter((o) => hasNoSignals(oracleConfigs[o]));
    const underlyingOracleMap: Record<string, string> = {};

    if (noSignalOracles.length > 0) {
      console.log(
        `Morpho oracles [${chainId}]: resolving ${noSignalOracles.length} wrapper oracles via currentOracle()`
      );

      const currentOracleResults = (await multicallRetryUniversal({
        chain: chainId,
        calls: noSignalOracles.map((o) => ({ address: o, name: "currentOracle", args: [] })),
        abi: CURRENT_ORACLE_ABI,
        allowFailure: true,
        maxRetries: 12,
      })) as (string | null)[];

      noSignalOracles.forEach((wrapper, i) => {
        const underlying = toAddr(currentOracleResults[i]);
        if (underlying) underlyingOracleMap[wrapper] = underlying;
      });

      const newUnderlyings = [...new Set(Object.values(underlyingOracleMap))].filter(
        (u) => !oracleConfigs[u]
      );
      if (newUnderlyings.length > 0) {
        console.log(
          `Morpho oracles [${chainId}]: fetching ${newUnderlyings.length} underlying oracle configs`
        );
        const { configs: underlyingConfigs, isV2Map: underlyingIsV2Map } =
          await fetchOracleConfigs(chainId, newUnderlyings);
        Object.assign(oracleConfigs, underlyingConfigs);
        Object.assign(isV2Map, underlyingIsV2Map);
      }

      for (const [wrapper, underlying] of Object.entries(underlyingOracleMap)) {
        oracleConfigs[wrapper] = oracleConfigs[underlying] ?? {
          baseFeed1: null, baseFeed2: null, quoteFeed1: null, quoteFeed2: null,
          baseVault: null, quoteVault: null,
        };
        // Wrapper inherits the V2 status of its underlying
        isV2Map[wrapper] = isV2Map[underlying] ?? false;
      }
    }

    // Batch 2b: for non-V2 oracles not resolved via currentOracle(), try vault oracle selectors.
    // These contracts expose symbol() (their own name) and accountingAsset() (the loan token).
    // Price description: "{oracle symbol} / {accountingAsset symbol}"
    const vaultOracleDescriptions: Record<string, string> = {};
    const nonV2Unresolved = oracles.filter((o) => !isV2Map[o] && !underlyingOracleMap[o]);

    if (nonV2Unresolved.length > 0) {
      console.log(
        `Morpho oracles [${chainId}]: probing ${nonV2Unresolved.length} non-V2 oracles for vault selectors`
      );

      const VAULT_ORACLE_ABI = [...VAULT_SYMBOL_ABI, ...VAULT_ACCOUNTING_ASSET_ABI];
      const probeResults = (await multicallRetryUniversal({
        chain: chainId,
        calls: nonV2Unresolved.flatMap((o) => [
          { address: o, name: "symbol", args: [] },
          { address: o, name: "accountingAsset", args: [] },
        ]),
        abi: VAULT_ORACLE_ABI,
        allowFailure: true,
        maxRetries: 12,
      })) as (string | null)[];

      const oracleSym: Record<string, string | null> = {};
      const oracleAcctAddr: Record<string, string | null> = {};

      nonV2Unresolved.forEach((oracle, i) => {
        const sym = probeResults[2 * i];
        const acct = probeResults[2 * i + 1];
        oracleSym[oracle] = typeof sym === "string" && sym !== "0x" && sym.length > 0 ? sym : null;
        oracleAcctAddr[oracle] = toAddr(acct);
      });

      const acctAddrSet = new Set(
        Object.values(oracleAcctAddr).filter((a): a is string => a !== null)
      );
      const acctAddrList = Array.from(acctAddrSet);

      if (acctAddrList.length > 0) {
        const acctSymResults = (await multicallRetryUniversal({
          chain: chainId,
          calls: acctAddrList.map((a) => ({ address: a, name: "symbol", args: [] })),
          abi: VAULT_SYMBOL_ABI,
          allowFailure: true,
          maxRetries: 12,
        })) as (string | null)[];

        const acctSymbols: Record<string, string | null> = {};
        acctAddrList.forEach((addr, i) => {
          const raw = acctSymResults[i];
          acctSymbols[addr] = typeof raw === "string" && raw !== "0x" && raw.length > 0 ? raw : null;
        });

        for (const oracle of nonV2Unresolved) {
          const sym = oracleSym[oracle];
          const acctAddr = oracleAcctAddr[oracle];
          const acctSym = acctAddr ? (acctSymbols[acctAddr] ?? null) : null;
          if (sym && acctSym) vaultOracleDescriptions[oracle] = `${sym} / ${acctSym}`;
        }
      }
    }

    // Collect unique feeds and vaults
    const feedSet = new Set<string>();
    const vaultSet = new Set<string>();
    for (const config of Object.values(oracleConfigs)) {
      if (config.baseFeed1) feedSet.add(config.baseFeed1);
      if (config.baseFeed2) feedSet.add(config.baseFeed2);
      if (config.quoteFeed1) feedSet.add(config.quoteFeed1);
      if (config.quoteFeed2) feedSet.add(config.quoteFeed2);
      if (config.baseVault) vaultSet.add(config.baseVault);
      if (config.quoteVault) vaultSet.add(config.quoteVault);
    }

    const feeds = Array.from(feedSet);
    const vaults = Array.from(vaultSet);
    const feedDescriptions: Record<string, string | null> = {};
    const vaultSymbols: Record<string, string | null> = {};
    const vaultUnderlyingAddrs: Record<string, string | null> = {};
    const assetSymbols: Record<string, string | null> = {};
    const asset2Addrs: Record<string, string | null> = {};
    const asset2Symbols: Record<string, string | null> = {};

    // Batch 3: description() for all unique feeds
    if (feeds.length > 0) {
      console.log(`Morpho oracles [${chainId}]: fetching ${feeds.length} feed descriptions`);
      const descResults = (await multicallRetryUniversal({
        chain: chainId,
        calls: feeds.map((f) => ({ address: f, name: "description", args: [] })),
        abi: FEED_DESCRIPTION_ABI,
        allowFailure: true,
        maxRetries: 12,
      })) as (string | null)[];

      feeds.forEach((feed, i) => {
        const raw = descResults[i];
        if (typeof raw === "string" && raw !== "0x" && raw.length > 0) {
          feedDescriptions[feed] = normalizeGenericDescription(normalizeRedStoneDescription(raw));
        } else {
          feedDescriptions[feed] = null;
        }
      });

      // Batch 3b: for feeds with unhelpful RedStone descriptions (no pair info),
      // call getDataFeedId() to recover the token symbol, then synthesize "X / USD".
      const redstoneFeeds = feeds.filter((f) => {
        const desc = feedDescriptions[f];
        return desc !== null && /redstone/i.test(desc) && !desc.includes("/");
      });

      if (redstoneFeeds.length > 0) {
        console.log(
          `Morpho oracles [${chainId}]: resolving ${redstoneFeeds.length} RedStone feed IDs`
        );
        const feedIdResults = (await multicallRetryUniversal({
          chain: chainId,
          calls: redstoneFeeds.map((f) => ({ address: f, name: "getDataFeedId", args: [] })),
          abi: REDSTONE_DATA_FEED_ID_ABI,
          allowFailure: true,
          maxRetries: 12,
        })) as (string | null)[];

        redstoneFeeds.forEach((feed, i) => {
          const symbol = decodeBytes32String(feedIdResults[i]);
          if (symbol) {
            // Treat decoded bytes32 as the "content" of a RedStone description and normalize it
            feedDescriptions[feed] = normalizeRedStoneDescription(
              `RedStone Price Feed for ${symbol}`
            );
          }
        });
      }
    }

    // Batch 4: symbol() + asset() for all unique vaults (in one batch using combined ABI)
    if (vaults.length > 0) {
      console.log(`Morpho oracles [${chainId}]: fetching ${vaults.length} vault symbols and assets`);

      const VAULT_INFO_ABI = [...VAULT_SYMBOL_ABI, ...VAULT_ASSET_ABI];

      const vaultInfoResults = (await multicallRetryUniversal({
        chain: chainId,
        calls: vaults.flatMap((v) => [
          { address: v, name: "symbol", args: [] },
          { address: v, name: "asset", args: [] },
        ]),
        abi: VAULT_INFO_ABI,
        allowFailure: true,
        maxRetries: 12,
      })) as (string | null)[];

      vaults.forEach((vault, i) => {
        const sym = vaultInfoResults[2 * i];
        const asset = vaultInfoResults[2 * i + 1];
        vaultSymbols[vault] =
          typeof sym === "string" && sym !== "0x" && sym.length > 0 ? sym : null;
        vaultUnderlyingAddrs[vault] = toAddr(asset);
      });

      // Batch 5: symbol() + asset() for all unique vault underlying asset addresses
      // (asset() may fail for non-vault tokens — that's fine with allowFailure)
      const assetAddrSet = new Set(
        Object.values(vaultUnderlyingAddrs).filter((a): a is string => a !== null)
      );
      const assetAddrs = Array.from(assetAddrSet);

      if (assetAddrs.length > 0) {
        console.log(
          `Morpho oracles [${chainId}]: fetching ${assetAddrs.length} vault underlying symbols`
        );

        const ASSET_INFO_ABI = [...VAULT_SYMBOL_ABI, ...VAULT_ASSET_ABI];
        const assetInfoResults = (await multicallRetryUniversal({
          chain: chainId,
          calls: assetAddrs.flatMap((a) => [
            { address: a, name: "symbol", args: [] },
            { address: a, name: "asset", args: [] },
          ]),
          abi: ASSET_INFO_ABI,
          allowFailure: true,
          maxRetries: 12,
        })) as (string | null)[];

        assetAddrs.forEach((addr, i) => {
          const sym = assetInfoResults[2 * i];
          const asset2 = assetInfoResults[2 * i + 1];
          assetSymbols[addr] =
            typeof sym === "string" && sym !== "0x" && sym.length > 0 ? sym : null;
          asset2Addrs[addr] = toAddr(asset2);
        });

        // Batch 6: symbol() for second-level underlying addresses
        const asset2AddrSet = new Set(
          Object.values(asset2Addrs).filter((a): a is string => a !== null)
        );
        const asset2AddrList = Array.from(asset2AddrSet);

        if (asset2AddrList.length > 0) {
          console.log(
            `Morpho oracles [${chainId}]: fetching ${asset2AddrList.length} second-level vault underlying symbols`
          );
          const asset2SymResults = (await multicallRetryUniversal({
            chain: chainId,
            calls: asset2AddrList.map((a) => ({ address: a, name: "symbol", args: [] })),
            abi: VAULT_SYMBOL_ABI,
            allowFailure: true,
            maxRetries: 12,
          })) as (string | null)[];

          asset2AddrList.forEach((addr, i) => {
            const raw = asset2SymResults[i];
            asset2Symbols[addr] =
              typeof raw === "string" && raw !== "0x" && raw.length > 0 ? raw : null;
          });
        }
      }
    }

    // Resolves to the deepest known underlying symbol for a vault's asset address.
    // Falls back to the first-level symbol if no second-level underlying is known.
    const getDeepUnderlyingSymbol = (assetAddr: string | null): string | null => {
      if (!assetAddr) return null;
      const deepAddr = asset2Addrs[assetAddr];
      if (deepAddr) {
        const deepSym = asset2Symbols[deepAddr];
        if (deepSym) return deepSym;
      }
      return assetSymbols[assetAddr] ?? null;
    };

    // Build result for this chain
    result[chainId] = {};
    for (const oracle of oracles) {
      const c = oracleConfigs[oracle];
      const b1Desc = c.baseFeed1 ? (feedDescriptions[c.baseFeed1] ?? null) : null;
      const b2Desc = c.baseFeed2 ? (feedDescriptions[c.baseFeed2] ?? null) : null;
      const q1Desc = c.quoteFeed1 ? (feedDescriptions[c.quoteFeed1] ?? null) : null;
      const q2Desc = c.quoteFeed2 ? (feedDescriptions[c.quoteFeed2] ?? null) : null;
      const bvSym = c.baseVault ? (vaultSymbols[c.baseVault] ?? null) : null;
      const qvSym = c.quoteVault ? (vaultSymbols[c.quoteVault] ?? null) : null;
      const bvAssetAddr = c.baseVault ? (vaultUnderlyingAddrs[c.baseVault] ?? null) : null;
      const qvAssetAddr = c.quoteVault ? (vaultUnderlyingAddrs[c.quoteVault] ?? null) : null;
      const bvUnderlying = getDeepUnderlyingSymbol(bvAssetAddr);
      const qvUnderlying = getDeepUnderlyingSymbol(qvAssetAddr);

      result[chainId][oracle] = {
        underlyingOracle: underlyingOracleMap[oracle] ?? null,
        baseFeed1: c.baseFeed1,
        baseFeed2: c.baseFeed2,
        quoteFeed1: c.quoteFeed1,
        quoteFeed2: c.quoteFeed2,
        baseVault: c.baseVault,
        quoteVault: c.quoteVault,
        baseFeed1Description: b1Desc,
        baseFeed2Description: b2Desc,
        quoteFeed1Description: q1Desc,
        quoteFeed2Description: q2Desc,
        baseVaultDescription: bvSym,
        baseVaultUnderlying: bvUnderlying,
        quoteVaultDescription: qvSym,
        quoteVaultUnderlying: qvUnderlying,
        priceDescription: (() => {
          const synthesized = synthesizePriceDescription(
            b1Desc, b2Desc, q1Desc, q2Desc,
            bvSym, bvUnderlying, qvSym, qvUnderlying
          );
          return synthesized !== "UNKNOWN"
            ? synthesized
            : (vaultOracleDescriptions[oracle] ?? "UNKNOWN");
        })(),
        // fixedRate: true only when the oracle is confirmed V2 (selectors responded)
        // but all feed/vault addresses are zero — a hardcoded static price oracle.
        // Non-V2 contracts that don't implement these selectors are left as null.
        fixedRate: isV2Map[oracle] && hasNoSignals(c) && !underlyingOracleMap[oracle] ? true : null,
      };
    }
  }

  return result;
}
