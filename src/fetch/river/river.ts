import { readFileSync } from "fs";
import { erc20Abi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { DataUpdater } from "../../types.js";
import { mergeData as deepMergeData } from "../../utils.js";

// ============================================================================
// River (rebranded Satoshi Protocol) market registry. Prisma/Liquity-V1-
// lineage pooled CDP behind a per-chain SatoshiXApp diamond: one TroveManager
// beacon proxy per collateral, address-keyed troves, protocol-set interest,
// decaying-baseRate mint fee, single per-chain StabilityPool.
//
// config/river.json seeds { xapp, debtToken } per chain; this updater
// enumerates TroveManagers on-chain via the diamond's FactoryFacet
// (troveManagerCount/troveManagers) and snapshots each TM's owner-MUTABLE
// params (MCR, interestRate, fee bounds, maxSystemDebt, gas comp, pause /
// sunset flags) plus the diamond-level minNetDebt into
// data/river-markets.json. Facets are resolved by the diamond itself — we
// only ever call the diamond (facet addresses get re-cut; docs are stale).
// ============================================================================

const MARKETS_FILE = "./data/river-markets.json";
const LABELS_FILE = "./data/lender-labels.json";

const DISPLAY: Record<string, { name: string; short: string }> = {
  RIVER: { name: "River", short: "River" },
};
const CONFIG_FILE = "./config/river.json";

type RiverChainCfg = { xapp: string; debtToken: string };
type RiverConfig = Record<string, Record<string, RiverChainCfg>>;

const DIAMOND_ABI = [
  {
    type: "function",
    name: "minNetDebt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "troveManagerCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "troveManagers",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const TM_READS = [
  "collateralToken",
  "sortedTroves",
  "MCR",
  "interestRate",
  "borrowingFeeFloor",
  "maxBorrowingFee",
  "maxSystemDebt",
  "debtGasCompensation",
  "paused",
  "sunsetting",
] as const;

const TM_ABI = TM_READS.map((name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [
    {
      name: "",
      type:
        name === "paused" || name === "sunsetting"
          ? "bool"
          : name === "collateralToken" || name === "sortedTroves"
            ? "address"
            : "uint256",
    },
  ],
})) as any;

function readConfig(): RiverConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

const addr = (v: any): string | undefined =>
  typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : undefined;
const num = (v: any): string | undefined =>
  typeof v === "bigint" || typeof v === "number" ? String(v) : undefined;

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
  } catch {
    /* tolerated — decimals default below */
  }
  tokens.forEach((t, i) => {
    const d = res[i * 2];
    const sym = res[i * 2 + 1];
    out[t.toLowerCase()] = {
      decimals: typeof d === "bigint" || typeof d === "number" ? Number(d) : 18,
      symbol: typeof sym === "string" && sym.length > 0 ? sym : undefined,
    };
  });
  return out;
}

async function fetchChain(
  lender: string,
  chainId: string,
  cfg: RiverChainCfg,
): Promise<{ minNetDebt: string; markets: any[] } | undefined> {
  const [minNetDebtRaw, countRaw] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      { address: cfg.xapp, name: "minNetDebt", args: [] },
      { address: cfg.xapp, name: "troveManagerCount", args: [] },
    ],
    abi: DIAMOND_ABI as any,
    allowFailure: false,
  })) as any[];
  const count = Number(countRaw);
  if (!Number.isFinite(count) || count === 0) {
    console.log(`River: ${lender} chain ${chainId}: no TroveManagers`);
    return { minNetDebt: num(minNetDebtRaw) ?? "0", markets: [] };
  }

  const tmAddrs = (
    (await multicallRetryUniversal({
      chain: chainId,
      calls: Array.from({ length: count }, (_, i) => ({
        address: cfg.xapp,
        name: "troveManagers",
        args: [i],
      })),
      abi: DIAMOND_ABI as any,
      allowFailure: false,
    })) as any[]
  ).map((a) => String(a).toLowerCase());

  const tmRes = (await multicallRetryUniversal({
    chain: chainId,
    calls: tmAddrs.flatMap((tm) =>
      TM_READS.map((name) => ({ address: tm, name, args: [] })),
    ),
    abi: TM_ABI,
    allowFailure: true,
  })) as any[];

  const markets = tmAddrs.map((tm, i) => {
    const r: Record<string, any> = {};
    TM_READS.forEach((name, j) => {
      r[name] = tmRes[i * TM_READS.length + j];
    });
    return {
      index: i,
      troveManager: tm,
      sortedTroves: addr(r.sortedTroves),
      collToken: addr(r.collateralToken),
      mcr: num(r.MCR),
      interestRate: num(r.interestRate),
      borrowingFeeFloor: num(r.borrowingFeeFloor),
      maxBorrowingFee: num(r.maxBorrowingFee),
      maxSystemDebt: num(r.maxSystemDebt),
      debtGasCompensation: num(r.debtGasCompensation),
      paused: r.paused === true,
      sunsetting: r.sunsetting === true,
    };
  });

  const meta = await resolveTokenMeta(chainId, [
    ...markets.map((m) => m.collToken).filter((t): t is string => !!t),
    cfg.debtToken,
  ]);
  const debtSymbol = meta[cfg.debtToken.toLowerCase()]?.symbol ?? "satUSD";
  for (const m of markets) {
    const t = m.collToken ? meta[m.collToken] : undefined;
    (m as any).collDecimals = t?.decimals ?? 18;
    if (t?.symbol) (m as any).name = `${debtSymbol} / ${t.symbol}`;
  }

  console.log(
    `River: ${lender} chain ${chainId}: ${markets.length} TroveManagers`,
  );
  return { minNetDebt: num(minNetDebtRaw) ?? "0", markets };
}

export class RiverUpdater implements DataUpdater {
  name = "River (Satoshi) Markets";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    const config = readConfig();
    const lenders = Object.keys(config);
    if (lenders.length === 0) {
      console.log("River: no deployments in config/river.json, skipping");
      return { [MARKETS_FILE]: {} };
    }

    const result: Record<string, Record<string, any>> = {};
    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};
    for (const lender of lenders) {
      const disp = DISPLAY[lender] ?? { name: lender, short: lender };
      names[lender] = disp.name;
      shortNames[lender] = disp.short;
      for (const [chainId, cfg] of Object.entries(config[lender])) {
        try {
          const data = await fetchChain(lender, chainId, cfg);
          if (!data) continue;
          if (!result[lender]) result[lender] = {};
          result[lender][chainId] = data;
          // Per-market labels. Keys embed the CHAIN ID
          // (`RIVER_<chainId>_<index>`, Fluid convention) so they are
          // globally unique; the SAME collateral can still back several
          // TroveManagers on ONE chain (two clBTC markets on Base) —
          // those get the factory index as a suffix.
          const counts: Record<string, number> = {};
          for (const m of data.markets) {
            const coll = (m as any).name?.split(" / ").pop() ?? `#${m.index}`;
            counts[coll] = (counts[coll] ?? 0) + 1;
          }
          for (const m of data.markets) {
            const coll = (m as any).name?.split(" / ").pop() ?? `#${m.index}`;
            const label = counts[coll] > 1 ? `${coll} #${m.index}` : coll;
            const key = `${lender}_${chainId}_${m.index}`;
            names[key] = `${disp.name} ${label}`;
            shortNames[key] = `${disp.short} ${label}`;
          }
        } catch (e) {
          console.log(
            `River: ${lender} chain ${chainId} failed:`,
            (e as any)?.shortMessage ?? (e as any)?.message ?? e,
          );
        }
      }
    }
    return { [MARKETS_FILE]: result, [LABELS_FILE]: { names, shortNames } };
  }

  /** Replace per lender+chain when the fetch returned markets; keep old on empty. */
  mergeData(oldData: any, data: any, fileKey?: string): any {
    // Labels file is shared across every lender family — accumulate.
    if (fileKey === LABELS_FILE) {
      return deepMergeData(oldData ?? {}, data ?? {});
    }
    const merged: Record<string, Record<string, any>> = { ...(oldData ?? {}) };
    for (const [lender, chains] of Object.entries(
      (data ?? {}) as Record<string, Record<string, any>>,
    )) {
      merged[lender] = { ...(merged[lender] ?? {}) };
      for (const [chainId, chainData] of Object.entries(chains)) {
        if (Array.isArray(chainData?.markets) && chainData.markets.length > 0) {
          merged[lender][chainId] = chainData;
        } else if (!merged[lender][chainId]) {
          merged[lender][chainId] = chainData ?? {
            minNetDebt: "0",
            markets: [],
          };
        }
      }
    }
    return merged;
  }
}
