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

      const provider = (oracle ? nameByOracle.get(oracle) : null) ?? "fluid-oracle";

      // Fluid prices collateral in debt terms; record the intended pair for inspection.
      // The reported pair isn't decodable from these bespoke oracles, so correctness is
      // left unverified (null) rather than guessed.
      const collSym = collateralSymbols[0] ?? null;
      const debtSym = debtSymbols[0] ?? null;
      const intendedPair = collSym && debtSym ? `${collSym} / ${debtSym}` : null;

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
        priceDescription: "UNKNOWN",
        underlyingAggregator: null,
        intendedPair,
        correctOracle: null,
        denominatorMatch: null,
      };
    }
  }

  return result;
}
