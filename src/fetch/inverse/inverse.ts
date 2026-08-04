import { readFileSync } from "fs";
import { multicallRetryUniversal } from "@1delta/providers";
import { DataUpdater } from "../../types.js";
import { mergeData as deepMergeData } from "../../utils.js";

// ============================================================================
// Inverse Finance FiRM market registry. Ethereum-only CDP: one Market
// contract per collateral, DOLA-only borrow, DBR-prepaid interest,
// per-user CREATE2 escrows.
//
// config/inverse.json seeds { dola, dbr, oracle, borrowController } (and
// gets its `dbrPriceDolaSnapshot` refreshed from /api/dbr each run). The
// market ROSTER is discovered from the protocol's own fixed-markets API,
// but every candidate is then VERIFIED on-chain and the on-chain values
// win — a market that fails verification is dropped, so a compromised
// API cannot inject rows. minDebt / dailyLimit come from the
// BorrowController when readable, the API otherwise.
//
// Inclusion rule: non-Pendle collateral (fixed-maturity PT collateral
// needs its own modeling) AND (borrowing live OR totalDebt > 1,000 DOLA
// — paused markets with a live book stay listed so existing borrowers'
// positions remain visible in user data; long-dead empty markets drop).
// ============================================================================

const MARKETS_FILE = "./data/inverse-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/inverse.json";

const FIXED_MARKETS_URL = "https://www.inverse.finance/api/f2/fixed-markets";
const DBR_URL = "https://www.inverse.finance/api/dbr";

/** Paused markets keep their row while the book is above this (DOLA). */
const PAUSED_DEBT_FLOOR = 1_000;

const DISPLAY = { INVERSE: { name: "Inverse", short: "Inverse" } } as const;

type InverseChainCfg = {
  dola: string;
  dbr: string;
  oracle: string;
  borrowController: string;
  debtDecimals?: number;
  dbrPriceDolaSnapshot?: string;
};
type InverseConfig = Record<string, Record<string, InverseChainCfg>>;

const MARKET_READS = [
  "collateral",
  "escrowImplementation",
  "collateralFactorBps",
  "liquidationIncentiveBps",
  "liquidationFactorBps",
  "borrowPaused",
] as const;

const MARKET_ABI = MARKET_READS.map((name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [
    {
      name: "",
      type:
        name === "borrowPaused"
          ? "bool"
          : name === "collateral" || name === "escrowImplementation"
            ? "address"
            : "uint256",
    },
  ],
})) as any;

const CONTROLLER_ABI = [
  {
    type: "function",
    name: "minDebts",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "dailyLimits",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as any;

function readConfig(): InverseConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Prefer a non-zero on-chain value; otherwise the API fallback. */
function nonZeroOr(v: string | undefined, fallback: string): string {
  return v !== undefined && v !== "0" ? v : fallback;
}

/** Raw 1e18 → human integer string ('3000'); undefined on garbage. */
function humanFromRay18(v: any): string | undefined {
  if (typeof v !== "bigint") return undefined;
  return (v / 10n ** 18n).toString();
}

async function fetchChain(
  lender: string,
  chainId: string,
  cfg: InverseChainCfg,
): Promise<{ markets: any[] } | undefined> {
  const api = await fetchJson(FIXED_MARKETS_URL);
  const candidates = (api?.markets ?? []).filter(
    (m: any) =>
      m?.address &&
      m?.collateral &&
      typeof m?.decimals === "number" &&
      !m?.isPendle &&
      (m?.borrowPaused !== true || Number(m?.totalDebt ?? 0) > PAUSED_DEBT_FLOOR),
  );
  if (candidates.length === 0) {
    console.log(`Inverse: chain ${chainId}: API returned no candidates`);
    return undefined;
  }

  // On-chain verification — the API is discovery only; these values WIN.
  const verify = (await multicallRetryUniversal({
    chain: chainId,
    calls: candidates.flatMap((m: any) =>
      MARKET_READS.map((name) => ({ address: m.address, name, args: [] })),
    ),
    abi: MARKET_ABI,
    allowFailure: true,
  })) as any[];

  const controller = (await multicallRetryUniversal({
    chain: chainId,
    calls: candidates.flatMap((m: any) => [
      { address: cfg.borrowController, name: "minDebts", args: [m.address] },
      { address: cfg.borrowController, name: "dailyLimits", args: [m.address] },
    ]),
    abi: CONTROLLER_ABI,
    allowFailure: true,
  })) as any[];

  const markets: any[] = [];
  candidates.forEach((m: any, i: number) => {
    const base = i * MARKET_READS.length;
    const r: Record<string, any> = {};
    MARKET_READS.forEach((name, j) => {
      r[name] = verify[base + j];
    });
    // Verification: on-chain collateral must exist and match the API row.
    const chainColl =
      typeof r.collateral === "string" ? r.collateral.toLowerCase() : undefined;
    if (!chainColl || chainColl !== String(m.collateral).toLowerCase()) {
      console.log(
        `Inverse: chain ${chainId}: DROPPING ${m.name} (${m.address}) — on-chain verification failed`,
      );
      return;
    }
    const bps = (v: any, apiVal: number): string =>
      typeof v === "bigint" ? v.toString() : String(Math.round(apiVal * 10000));
    markets.push({
      address: String(m.address).toLowerCase(),
      collToken: chainColl,
      collDecimals: m.decimals,
      escrowImplementation: String(
        typeof r.escrowImplementation === "string"
          ? r.escrowImplementation
          : m.escrowImplementation,
      ).toLowerCase(),
      collateralFactorBps: bps(r.collateralFactorBps, m.collateralFactor ?? 0),
      liquidationIncentiveBps: bps(
        r.liquidationIncentiveBps,
        m.liquidationIncentive ?? 0,
      ),
      liquidationFactorBps: bps(r.liquidationFactorBps, m.liquidationFactor ?? 1),
      // Controller reads of 0 mean "mapping unset" on markets paused before
      // the v4 migration — fall back to the API's number rather than store a
      // misleading zero.
      minDebt: nonZeroOr(
        humanFromRay18(controller[i * 2]),
        String(m.minDebt ?? "0"),
      ),
      dailyLimit: nonZeroOr(
        humanFromRay18(controller[i * 2 + 1]),
        String(m.dailyLimit ?? "0"),
      ),
      borrowPaused:
        typeof r.borrowPaused === "boolean"
          ? r.borrowPaused
          : m.borrowPaused === true,
      name: m.name,
    });
  });

  console.log(`Inverse: chain ${chainId}: ${markets.length} markets verified`);
  return { markets };
}

export class InverseUpdater implements DataUpdater {
  name = "Inverse FiRM Markets";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    const config = readConfig();
    const lenders = Object.keys(config);
    if (lenders.length === 0) {
      console.log("Inverse: no deployments in config/inverse.json, skipping");
      return { [MARKETS_FILE]: {} };
    }

    const result: Record<string, Record<string, any>> = {};
    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};
    const configOut: InverseConfig = {};

    // DBR price snapshot refresh (the RUNTIME rate is live from /api/dbr;
    // this snapshot is only the fetcher's offline fallback).
    let dbrSnapshot: string | undefined;
    try {
      const dbr = await fetchJson(DBR_URL);
      const p = Number(dbr?.priceDola);
      if (Number.isFinite(p) && p > 0) dbrSnapshot = p.toFixed(4);
    } catch {
      /* keep the old snapshot */
    }

    for (const lender of lenders) {
      const disp =
        DISPLAY[lender as keyof typeof DISPLAY] ?? { name: lender, short: lender };
      names[lender] = disp.name;
      shortNames[lender] = disp.short;
      for (const [chainId, cfg] of Object.entries(config[lender])) {
        try {
          const data = await fetchChain(lender, chainId, cfg);
          if (!data) continue;
          if (!result[lender]) result[lender] = {};
          result[lender][chainId] = data;
          if (dbrSnapshot) {
            (configOut[lender] ??= {})[chainId] = {
              ...cfg,
              dbrPriceDolaSnapshot: dbrSnapshot,
            };
          }
          // Per-market labels — keys are `INVERSE_<MARKET_HEX_UPPER>`.
          for (const m of data.markets) {
            const key = `${lender}_${String(m.address).slice(2).toUpperCase()}`;
            names[key] = `${disp.name} ${m.name}`;
            shortNames[key] = `${disp.short} ${m.name}`;
          }
        } catch (e) {
          console.log(
            `Inverse: ${lender} chain ${chainId} failed:`,
            (e as any)?.shortMessage ?? (e as any)?.message ?? e,
          );
        }
      }
    }

    const out: { [file: string]: any } = {
      [MARKETS_FILE]: result,
      [LABELS_FILE]: { names, shortNames },
    };
    if (Object.keys(configOut).length > 0) out[CONFIG_FILE] = configOut;
    return out;
  }

  /** Replace per lender+chain when the fetch returned markets; keep old on empty. */
  mergeData(oldData: any, data: any, fileKey?: string): any {
    // Labels + config are shared/seeded files — deep-merge, never replace.
    if (fileKey === LABELS_FILE || fileKey === CONFIG_FILE) {
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
          merged[lender][chainId] = chainData ?? { markets: [] };
        }
      }
    }
    return merged;
  }
}
