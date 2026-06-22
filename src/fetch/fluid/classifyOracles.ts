import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { vaultResolverAbi } from "./abi.js";
import { FLUID_RESOLVERS } from "./constants.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";

const fluidVaultsFile = "./data/fluid-vaults.json";

const NAME_ABI = [
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "description", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
];

// Every FluidOracle exposes the live collateral→debt exchange rate. A non-zero
// answer proves the oracle is wired and prices the vault's configured pair.
const EXCHANGE_RATE_ABI = [
  { inputs: [], name: "getExchangeRateOperate", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
];

// Map a Fluid oracle CONTRACT NAME (from Sourcify) to its price mechanism. The
// names encode the source: "...CLRS.../Fallback..." = Chainlink/Redstone,
// "WstETH/WeETH/RsETH/sUSDe/..." = LST/yield exchange-rate, "DexSmart.../Peg..."
// = Fluid-internal composite, "UniV3..." (primary, not a CLRS check) = TWAP.
function providerFromContractName(name: string | null): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/wsteth|weeth|ezeth|rseth|wsteth|msteth|susde|susds|sdai|sweth|cdceth|lst|exchangerate|erc4626/.test(n))
    return "exchange-rate";
  if (/dexsmart|\bdex\b|peg/.test(n)) return "composite"; // Fluid DEX / peg composite
  if (/univ3/.test(n) && !/clrs|check/.test(n)) return "uniswap"; // primary TWAP
  if (/clrs|chainlink|fallback/.test(n)) return "chainlink";
  if (/redstone/.test(n)) return "redstone";
  return null;
}

const sourcifyNameCache = new Map<string, string | null>();

/** Fetch the verified contract name for an oracle from Sourcify (keyless). */
async function fetchSourcifyName(chainId: string, addr: string): Promise<string | null> {
  const key = `${chainId}:${addr.toLowerCase()}`;
  if (sourcifyNameCache.has(key)) return sourcifyNameCache.get(key)!;
  let name: string | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(
      `https://sourcify.dev/server/v2/contract/${chainId}/${addr}?fields=compilation`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (res.ok) {
      const j: any = await res.json();
      name = j?.compilation?.name ?? null;
    }
  } catch {
    /* network/unsupported chain → fall back to generic fluid-oracle */
  }
  sourcifyNameCache.set(key, name);
  return name;
}

/** Resolve per-oracle provider via Sourcify contract names, bounded concurrency. */
async function resolveFluidProviders(
  chainId: string,
  oracles: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CONC = 8;
  for (let i = 0; i < oracles.length; i += CONC) {
    const batch = oracles.slice(i, i + CONC);
    const names = await Promise.all(batch.map((o) => fetchSourcifyName(chainId, o)));
    batch.forEach((o, j) => {
      out.set(o, providerFromContractName(names[j]) ?? "fluid-oracle");
    });
  }
  return out;
}

type FluidVaultRaw = {
  supply?: { assets?: Array<{ underlying?: string }> };
  borrow?: { assets?: Array<{ underlying?: string }> };
  vaultId?: number;
  type?: number;
};

export type FluidOracleVaultData = {
  vault: string;
  vaultId: number | null;
  type: number | null;
  oracle: string | null;
  /** Collateral (supply) underlyings the vault prices. */
  collateral: string[];
  collateralSymbols: (string | null)[];
  /** Debt (borrow) underlyings — the numeraire the price is denominated in. */
  debt: string[];
  debtSymbols: (string | null)[];
  provider: string | null;
  /** Best-effort decoded reported pair from the oracle's source graph. */
  priceDescription: string;
  underlyingAggregator: string | null;
  /** Configured/intended pair "<collateral> / <debt>". */
  intendedPair: string | null;
  correctOracle: true | false | null;
  denominatorMatch: true | false | null;
};

export type FluidOraclesClassifiedMap = {
  [chainId: string]: { [vault: string]: FluidOracleVaultData };
};

export async function classifyFluidOracles(): Promise<FluidOraclesClassifiedMap> {
  const fluidVaults = readJsonFile(fluidVaultsFile) as Record<
    string,
    Record<string, FluidVaultRaw>
  >;

  const result: FluidOraclesClassifiedMap = {};

  for (const [chainId, byVault] of Object.entries(fluidVaults)) {
    const resolvers = FLUID_RESOLVERS[chainId];
    if (!resolvers) {
      console.warn(`Fluid oracles [${chainId}]: no resolver configured, skipping`);
      continue;
    }
    const vaults = Object.keys(byVault).map((v) => v.toLowerCase());
    if (vaults.length === 0) continue;
    console.log(`Fluid oracles [${chainId}]: ${vaults.length} vaults`);

    // 1. oracle address per vault via the vault resolver.
    // getVaultEntireData returns a very large struct, so chunk to keep each
    // multicall response manageable (a single 180-call batch overwhelms RPCs).
    const oracleByVault = new Map<string, string | null>();
    const CHUNK = 10;
    for (let off = 0; off < vaults.length; off += CHUNK) {
      const chunk = vaults.slice(off, off + CHUNK);
      const entire = (await multicallRetryUniversal({
        chain: chainId,
        calls: chunk.map((v) => ({
          address: resolvers.vaultResolver,
          name: "getVaultEntireData",
          args: [v],
        })),
        abi: vaultResolverAbi,
        allowFailure: true,
        maxRetries: 4,
      })) as any[];
      chunk.forEach((v, i) => {
        const r = entire[i];
        oracleByVault.set(v, r && r !== "0x" ? toAddr(r?.configs?.oracle) : null);
      });
      console.log(
        `  Fluid [${chainId}]: vault oracles ${Math.min(off + CHUNK, vaults.length)}/${vaults.length}`
      );
    }

    // 2. probe oracle provider names. Fluid oracles are bespoke (they return a single
    // collateral/debt exchange rate and don't expose a Chainlink-style pair), so we do
    // NOT walk their source graph — the full multi-selector probe across all of them
    // hangs the RPC. A lightweight name()/description() probe (chunked) is enough for a
    // wiring-level view: oracle address + provider + intended collateral/debt pair.
    const oracles = [...new Set([...oracleByVault.values()].filter((o): o is string => !!o))];
    console.log(`  Fluid [${chainId}]: probing ${oracles.length} oracle names`);
    const nameByOracle = new Map<string, string | null>();
    const NAME_CHUNK = 40;
    for (let off = 0; off < oracles.length; off += NAME_CHUNK) {
      const chunk = oracles.slice(off, off + NAME_CHUNK);
      const nameRes = (await multicallRetryUniversal({
        chain: chainId,
        calls: chunk.flatMap((o) => [
          { address: o, name: "name", args: [] },
          { address: o, name: "description", args: [] },
        ]),
        abi: NAME_ABI,
        allowFailure: true,
        maxRetries: 4,
      })) as unknown[];
      chunk.forEach((o, i) => {
        nameByOracle.set(o, asString(nameRes[2 * i]) ?? asString(nameRes[2 * i + 1]));
      });
    }

    // 2b. read the live exchange rate per oracle. Non-zero ⇒ the oracle is wired
    // and prices the vault's configured collateral/debt pair (correctOracle), even
    // though its internal feeds aren't introspectable. Zero/revert ⇒ broken/unset.
    const rateByOracle = new Map<string, bigint>();
    const RATE_CHUNK = 40;
    for (let off = 0; off < oracles.length; off += RATE_CHUNK) {
      const chunk = oracles.slice(off, off + RATE_CHUNK);
      const rateRes = (await multicallRetryUniversal({
        chain: chainId,
        calls: chunk.map((o) => ({ address: o, name: "getExchangeRateOperate", args: [] })),
        abi: EXCHANGE_RATE_ABI,
        allowFailure: true,
        maxRetries: 4,
      })) as unknown[];
      chunk.forEach((o, i) => {
        const v = rateRes[i];
        rateByOracle.set(o, typeof v === "bigint" ? v : 0n);
      });
    }

    // 2c. identify the price mechanism per oracle via its verified contract name
    // (Sourcify, keyless). Falls back to generic "fluid-oracle" when unavailable.
    console.log(`  Fluid [${chainId}]: resolving ${oracles.length} oracle mechanisms (Sourcify)`);
    const providerByOracle = await resolveFluidProviders(chainId, oracles);

    // 3. resolve underlying symbols (collateral + debt)
    const tokenSet = new Set<string>();
    for (const raw of Object.values(byVault)) {
      for (const a of raw.supply?.assets ?? []) {
        const u = toAddr(a.underlying);
        if (u) tokenSet.add(u);
      }
      for (const a of raw.borrow?.assets ?? []) {
        const u = toAddr(a.underlying);
        if (u) tokenSet.add(u);
      }
    }
    const tokens = [...tokenSet];
    const symRes =
      tokens.length > 0
        ? ((await multicallRetryUniversal({
            chain: chainId,
            calls: tokens.map((a) => ({ address: a, name: "symbol", args: [] })),
            abi: SYMBOL_ABI,
            allowFailure: true,
            maxRetries: 12,
          })) as unknown[])
        : [];
    const symbols = new Map<string, string | null>();
    tokens.forEach((a, i) => symbols.set(a, asString(symRes[i])));
    const symOf = (a: string | null) => (a ? symbols.get(a) ?? null : null);

    result[chainId] = {};
    for (const [vaultRaw, raw] of Object.entries(byVault)) {
      const vault = vaultRaw.toLowerCase();
      const oracle = oracleByVault.get(vault) ?? null;
      const collateral = (raw.supply?.assets ?? [])
        .map((a) => toAddr(a.underlying))
        .filter((a): a is string => !!a);
      const debt = (raw.borrow?.assets ?? [])
        .map((a) => toAddr(a.underlying))
        .filter((a): a is string => !!a);
      const collateralSymbols = collateral.map(symOf);
      const debtSymbols = debt.map(symOf);

      const provider =
        (oracle ? providerByOracle.get(oracle) : null) ??
        (oracle ? nameByOracle.get(oracle) : null) ??
        "fluid-oracle";

      // Fluid prices collateral in debt terms. The internal feeds aren't
      // introspectable, but a live (non-zero) exchange rate proves the oracle is
      // wired for exactly this vault's collateral/debt pair → report it as the
      // priced pair and correct. A zero/reverting rate is left unverified (and is
      // itself a signal the oracle is broken/unset).
      const collSym = collateralSymbols[0] ?? null;
      const debtSym = debtSymbols[0] ?? null;
      const intendedPair = collSym && debtSym ? `${collSym} / ${debtSym}` : null;
      const live = oracle ? (rateByOracle.get(oracle) ?? 0n) > 0n : false;
      const priced = live && collSym && debtSym;

      result[chainId][vault] = {
        vault,
        vaultId: raw.vaultId ?? null,
        type: raw.type ?? null,
        oracle,
        collateral,
        collateralSymbols,
        debt,
        debtSymbols,
        provider,
        priceDescription: priced ? `${collSym} / ${debtSym}` : "UNKNOWN",
        underlyingAggregator: null,
        intendedPair,
        correctOracle: priced ? true : null,
        denominatorMatch: priced ? true : null,
      };
    }
  }

  return result;
}
