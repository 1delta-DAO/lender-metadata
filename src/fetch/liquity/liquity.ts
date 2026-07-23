import { readFileSync } from "fs";
import { erc20Abi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { DataUpdater } from "../../types.js";
import { mergeData as deepMergeData } from "../../utils.js";

// ============================================================================
// Liquity V2 family branch registry. Mirrors the Aave-fork model: every
// deployment (Liquity V2 + friendly forks: Felix, USDaf, Nerite, Quill, …) is
// a row in config/liquity.json keyed `lender → chainId`, and ALL fork
// deviations (min debt, rate bounds, gas comp, debt caps, changed ratios,
// collateral wrappers, proxied/mutable params) are captured in metadata —
// shared SDK code never hardcodes them.
//
// This updater enumerates collateral branches on-chain from the deployment's
// CollateralRegistry and snapshots each branch's contract set + risk
// constants into data/liquity-markets.json (`lender → chainId → branches[]`).
// Constants are re-read every run because proxied forks (Felix, Ebisu) can
// change them via admin setters; vanilla deployments are immutable so the
// refresh is a no-op there.
//
// Address discovery: the branch AddressesRegistry exposes the full contract
// set + constants, but branch contracts do NOT expose the registry address
// itself (and priceFeed / defaultPool / gasPool / collSurplusPool / the
// liquidation penalties are internal elsewhere). So config seeds
// `branchAddressesRegistries` (ordered by collIndex). A branch without a
// seeded registry (e.g. a fork added one on-chain) still gets a partial
// entry from TroveManager + BorrowerOperations getters, and the run logs a
// warning to add the registry seed.
// ============================================================================

const MARKETS_FILE = "./data/liquity-markets.json";
const LABELS_FILE = "./data/lender-labels.json";

// Display names per deployment — parent labels plus the prefix for the
// per-branch labels (`<Brand> <COLL>`, short `<Short> <COLL>` — Fluid/Silo
// style). Falls back to the raw key for unlisted deployments.
const DISPLAY: Record<string, { name: string; short: string }> = {
  LIQUITY_V2: { name: "Liquity V2", short: "LQV2" },
  USDAF: { name: "Asymmetry USDaf", short: "USDaf" },
  FELIX: { name: "Felix", short: "Felix" },
  NERITE: { name: "Nerite", short: "Nerite" },
  QUILL: { name: "Quill Finance", short: "Quill" },
  ENOSYS_LOANS: { name: "Enosys Loans", short: "Enosys" },
  SONETA: { name: "Soneta", short: "Soneta" },
  EBISU: { name: "Ebisu", short: "Ebisu" },
};
const CONFIG_FILE = "./config/liquity.json";

type LiquityChainCfg = {
  collateralRegistry: string;
  boldToken: string;
  hasDebtCaps?: boolean;
  branchAddressesRegistries?: string[];
  /** Fork wrapper tokens: collIndex → the user-facing asset the branch
   *  collateral wraps (Felix feUBTC←UBTC, USDaf WBTC18←WBTC, Soneta
   *  WSTA-LBTC←LBTC). Copied onto the generated branch records. */
  collWrappers?: Record<string, string>;
};
type LiquityConfig = Record<string, Record<string, LiquityChainCfg>>;

// Minimal inlined ABI fragments (not imported from @1delta/abis so the
// nightly job is robust to abis version drift, like the Midnight updater).
const COLLATERAL_REGISTRY_ABI = [
  {
    type: "function",
    name: "totalCollaterals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getToken",
    stateMutability: "view",
    inputs: [{ name: "_index", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getTroveManager",
    stateMutability: "view",
    inputs: [{ name: "_index", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// Ordered read set against a branch AddressesRegistry. `troveManager` doubles
// as the sanity check against the CollateralRegistry enumeration.
const REGISTRY_READS = [
  "collToken",
  "borrowerOperations",
  "troveManager",
  "troveNFT",
  "stabilityPool",
  "priceFeed",
  "activePool",
  "defaultPool",
  "gasPoolAddress",
  "collSurplusPool",
  "sortedTroves",
  "CCR",
  "MCR",
  "SCR",
  "BCR",
  "LIQUIDATION_PENALTY_SP",
  "LIQUIDATION_PENALTY_REDISTRIBUTION",
] as const;

const ADDRESSES_REGISTRY_ABI = REGISTRY_READS.map((name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [
    { name: "", type: name === name.toUpperCase() ? "uint256" : "address" },
  ],
})) as any;

// Partial-mode fallback getters when no AddressesRegistry is seeded for a
// branch: everything TroveManager + BorrowerOperations expose publicly.
const TROVE_MANAGER_ABI = [
  ...[
    "troveNFT",
    "borrowerOperations",
    "stabilityPool",
    "sortedTroves",
    "activePool",
  ].map((name) => ({
    type: "function",
    name,
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  })),
  // Non-vanilla fork extension (Nerite-style per-branch debt cap); called with
  // allowFailure and only consumed when the deployment sets `hasDebtCaps`.
  {
    type: "function",
    name: "getDebtLimit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as any;

const BORROWER_OPERATIONS_ABI = ["CCR", "MCR", "SCR", "BCR"].map((name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "uint256" }],
})) as any;

function readConfig(): LiquityConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

const addr = (v: any): string | undefined =>
  typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : undefined;
const wad = (v: any): string | undefined =>
  typeof v === "bigint" || typeof v === "number" ? String(v) : undefined;

/** Resolve decimals + symbol for a set of tokens via a single multicall. */
async function resolveTokenMeta(
  chainId: string,
  tokens: string[],
): Promise<Record<string, { decimals: number; symbol?: string }>> {
  const out: Record<string, { decimals: number; symbol?: string }> = {};
  if (tokens.length === 0) return out;
  const calls = tokens.flatMap((t) => [
    { address: t, name: "decimals", args: [] },
    { address: t, name: "symbol", args: [] },
  ]);
  let res: any[] = [];
  try {
    res = (await multicallRetryUniversal({
      chain: chainId,
      calls,
      abi: erc20Abi as any,
      allowFailure: true,
    })) as any[];
  } catch (e) {
    console.log(
      `Liquity: token-meta multicall failed on chain ${chainId}:`,
      (e as any)?.shortMessage ?? (e as any)?.message ?? e,
    );
  }
  tokens.forEach((t, i) => {
    const dRaw = res[i * 2];
    const sRaw = res[i * 2 + 1];
    out[t.toLowerCase()] = {
      decimals:
        typeof dRaw === "bigint" || typeof dRaw === "number"
          ? Number(dRaw)
          : 18,
      symbol: typeof sRaw === "string" && sRaw.length > 0 ? sRaw : undefined,
    };
  });
  return out;
}

async function fetchBranches(
  lender: string,
  chainId: string,
  cfg: LiquityChainCfg,
): Promise<any[]> {
  // 1. Enumerate branches from the CollateralRegistry (source of truth for
  //    collIndex — catches branches added after the config was seeded).
  const [totalRaw] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      { address: cfg.collateralRegistry, name: "totalCollaterals", args: [] },
    ],
    abi: COLLATERAL_REGISTRY_ABI as any,
    allowFailure: false,
  })) as any[];
  const total = Number(totalRaw);
  if (!Number.isFinite(total) || total === 0) {
    console.log(`Liquity: ${lender} chain ${chainId}: no branches found`);
    return [];
  }

  const enumRes = (await multicallRetryUniversal({
    chain: chainId,
    calls: Array.from({ length: total }, (_, i) => i).flatMap((i) => [
      { address: cfg.collateralRegistry, name: "getToken", args: [i] },
      { address: cfg.collateralRegistry, name: "getTroveManager", args: [i] },
    ]),
    abi: COLLATERAL_REGISTRY_ABI as any,
    allowFailure: false,
  })) as any[];

  const branches: any[] = [];
  const regs = cfg.branchAddressesRegistries ?? [];

  // 2. Full read via seeded AddressesRegistry (one batched multicall for all
  //    seeded branches), partial fallback via TroveManager + BorrowerOperations.
  const regCalls = regs
    .slice(0, total)
    .flatMap((reg) =>
      REGISTRY_READS.map((name) => ({ address: reg, name, args: [] })),
    );
  let regRes: any[] = [];
  if (regCalls.length > 0) {
    regRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: regCalls,
      abi: ADDRESSES_REGISTRY_ABI,
      allowFailure: true,
    })) as any[];
  }

  for (let i = 0; i < total; i++) {
    const collToken = String(enumRes[i * 2]).toLowerCase();
    const troveManager = String(enumRes[i * 2 + 1]).toLowerCase();
    const reg = regs[i];
    const entry: any = { collIndex: i, collToken, troveManager };
    const wrapper = cfg.collWrappers?.[String(i)];
    if (wrapper) entry.collWrapper = wrapper.toLowerCase();

    if (reg) {
      const r: Record<string, any> = {};
      REGISTRY_READS.forEach((name, j) => {
        r[name] = regRes[i * REGISTRY_READS.length + j];
      });
      const regTm = addr(r.troveManager);
      if (regTm && regTm !== troveManager) {
        console.log(
          `Liquity: ${lender} chain ${chainId} collIndex ${i}: seeded AddressesRegistry ${reg} points at TroveManager ${regTm}, expected ${troveManager} — check branchAddressesRegistries ordering`,
        );
      } else {
        entry.addressesRegistry = reg.toLowerCase();
        entry.borrowerOperations = addr(r.borrowerOperations);
        entry.troveNFT = addr(r.troveNFT);
        entry.stabilityPool = addr(r.stabilityPool);
        entry.priceFeed = addr(r.priceFeed);
        entry.activePool = addr(r.activePool);
        entry.defaultPool = addr(r.defaultPool);
        entry.gasPool = addr(r.gasPoolAddress);
        entry.collSurplusPool = addr(r.collSurplusPool);
        entry.sortedTroves = addr(r.sortedTroves);
        entry.ccr = wad(r.CCR);
        entry.mcr = wad(r.MCR);
        entry.scr = wad(r.SCR);
        entry.bcr = wad(r.BCR);
        entry.liquidationPenaltySP = wad(r.LIQUIDATION_PENALTY_SP);
        entry.liquidationPenaltyRedistribution = wad(
          r.LIQUIDATION_PENALTY_REDISTRIBUTION,
        );
      }
    }

    if (!entry.borrowerOperations) {
      if (!reg) {
        console.log(
          `Liquity: ${lender} chain ${chainId} collIndex ${i}: no AddressesRegistry seeded — emitting partial branch (add it to config/liquity.json branchAddressesRegistries)`,
        );
      }
      const tmRes = (await multicallRetryUniversal({
        chain: chainId,
        calls: [
          "troveNFT",
          "borrowerOperations",
          "stabilityPool",
          "sortedTroves",
          "activePool",
        ].map((name) => ({ address: troveManager, name, args: [] })),
        abi: TROVE_MANAGER_ABI,
        allowFailure: true,
      })) as any[];
      entry.troveNFT = addr(tmRes[0]);
      entry.borrowerOperations = addr(tmRes[1]);
      entry.stabilityPool = addr(tmRes[2]);
      entry.sortedTroves = addr(tmRes[3]);
      entry.activePool = addr(tmRes[4]);
      if (entry.borrowerOperations) {
        const boRes = (await multicallRetryUniversal({
          chain: chainId,
          calls: ["CCR", "MCR", "SCR", "BCR"].map((name) => ({
            address: entry.borrowerOperations,
            name,
            args: [],
          })),
          abi: BORROWER_OPERATIONS_ABI,
          allowFailure: true,
        })) as any[];
        entry.ccr = wad(boRes[0]);
        entry.mcr = wad(boRes[1]);
        entry.scr = wad(boRes[2]);
        entry.bcr = wad(boRes[3]);
      }
    }

    branches.push(entry);
  }

  // 3. Optional per-branch debt caps (Nerite-style TroveManager.getDebtLimit).
  if (cfg.hasDebtCaps) {
    const capRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: branches.map((b) => ({
        address: b.troveManager,
        name: "getDebtLimit",
        args: [],
      })),
      abi: TROVE_MANAGER_ABI,
      allowFailure: true,
    })) as any[];
    branches.forEach((b, i) => {
      const cap = wad(capRes[i]);
      if (cap) b.debtCap = cap;
    });
  }

  // 4. Collateral decimals + display names.
  const meta = await resolveTokenMeta(chainId, [
    ...branches.map((b) => b.collToken),
    cfg.boldToken,
  ]);
  const stableSymbol = meta[cfg.boldToken.toLowerCase()]?.symbol ?? "BOLD";
  for (const b of branches) {
    const m = meta[b.collToken];
    b.collDecimals = m?.decimals ?? 18;
    if (m?.symbol) b.name = `${stableSymbol} / ${m.symbol}`;
  }

  console.log(
    `Liquity: ${lender} chain ${chainId}: ${branches.length} branches`,
  );
  return branches;
}

export class LiquityUpdater implements DataUpdater {
  name = "Liquity V2 Family Markets";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    const config = readConfig();
    const lenders = Object.keys(config);
    if (lenders.length === 0) {
      console.log("Liquity: no deployments in config/liquity.json, skipping");
      return { [MARKETS_FILE]: {} };
    }

    const result: Record<string, Record<string, any[]>> = {};
    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};
    for (const lender of lenders) {
      const disp = DISPLAY[lender] ?? { name: lender, short: lender };
      names[lender] = disp.name;
      shortNames[lender] = disp.short;
      // Per-branch labels. Market keys embed the CHAIN ID
      // (`<LENDER>_<chainId>_<collIndex>`, Fluid convention) so they are
      // globally unique — every branch gets a `<Brand> <COLL>` label.
      for (const [chainId, cfg] of Object.entries(config[lender])) {
        try {
          const branches = await fetchBranches(lender, chainId, cfg);
          if (!result[lender]) result[lender] = {};
          result[lender][chainId] = branches;
          for (const b of branches) {
            const coll = b.name?.split(" / ").pop() ?? `#${b.collIndex}`;
            const key = `${lender}_${chainId}_${b.collIndex}`;
            names[key] = `${disp.name} ${coll}`;
            shortNames[key] = `${disp.short} ${coll}`;
          }
        } catch (e) {
          console.log(
            `Liquity: ${lender} chain ${chainId} failed:`,
            (e as any)?.shortMessage ?? (e as any)?.message ?? e,
          );
        }
      }
    }
    return { [MARKETS_FILE]: result, [LABELS_FILE]: { names, shortNames } };
  }

  /**
   * Replace each lender+chain branch list with the freshly-fetched set (branch
   * constants are mutable on proxied forks, so append-only would go stale).
   * Guard: keep old data when a fetch came back empty for a lender+chain that
   * previously had branches (transient RPC blip protection).
   */
  mergeData(oldData: any, data: any, fileKey?: string): any {
    // Labels file is shared across every lender family — accumulate, never
    // replace (matches the Midnight updater).
    if (fileKey === LABELS_FILE) {
      return deepMergeData(oldData ?? {}, data ?? {});
    }
    const merged: Record<string, Record<string, any[]>> = {
      ...(oldData ?? {}),
    };
    for (const [lender, chains] of Object.entries(
      (data ?? {}) as Record<string, Record<string, any[]>>,
    )) {
      merged[lender] = { ...(merged[lender] ?? {}) };
      for (const [chainId, branches] of Object.entries(chains)) {
        if (Array.isArray(branches) && branches.length > 0) {
          merged[lender][chainId] = branches;
        } else if (!merged[lender][chainId]) {
          merged[lender][chainId] = [];
        }
      }
    }
    return merged;
  }
}
