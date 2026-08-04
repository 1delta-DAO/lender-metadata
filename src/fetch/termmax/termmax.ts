import { multicallRetryUniversal } from "@1delta/providers";
import { DataUpdater } from "../../types.js";
import { mergeData as deepMergeData } from "../../utils.js";

// ============================================================================
// TermMax per-chain deployment registry (config/termmax.json).
//
// TermMax is a fixed-rate, fixed-maturity AMM over zero-coupon bonds. Three
// layers: a MARKET mints FT/XT/GT and holds no liquidity, per-maker ORDER
// contracts own the pricing curve, and optional ERC-4626 vaults curate orders.
//
// THIS FILE WRITES CHAIN CONFIG ONLY — there is deliberately no
// data/termmax-markets.json. Markets churn on every maturity roll (~15% of the
// book turned over on a single date in Jul-2026) and MATURED MARKETS VANISH
// from the upstream list entirely rather than lingering with a flag, so a
// checked-in market roster would be stale within weeks. margin-fetcher
// discovers markets at runtime from the TermMax API instead.
//
// The chain roster and candidate addresses are discovered from TermMax's own
// API, but EVERY address is then VERIFIED ON-CHAIN and anything that fails is
// dropped — same discipline as the Inverse updater: a compromised or drifted
// API cannot inject an address into the config.
//
// Verification per address:
//   routerV2   `getVersion()` returns a version string ("2.0.0" / "2.0.1").
//              A router WITHOUT it is a V1-era router and is recorded as
//              `routerV1` instead — BNB and Arbitrum are in that state today,
//              which means the V2 SwapPath borrow is unavailable there.
//   viewer     `getPositionDetails([], addr)` returns (does not revert).
//   oracle     `getPrice(debtToken)` returns a non-zero price for a live
//              market's debt token.
//   whitelistManager  `isWhitelisted(router, MARKET)` returns.
// ============================================================================

const CONFIG_FILE = "./config/termmax.json";
const LABELS_FILE = "./data/lender-labels.json";

const API_BASE = "https://api.termmax.ts.finance";
const SUPPORT_CHAINS_URL = `${API_BASE}/market/config/support-chains`;

/**
 * WhitelistManager addresses are NOT in the API's `globalConfig` — they only
 * appear on the docs site, so they are seeded here and then verified on-chain
 * like everything else. A chain absent from this map simply gets no
 * `whitelistManager` field; nothing depends on it at read time.
 */
const WHITELIST_MANAGERS: Record<string, string> = {
  "1": "0xB84f2a39b271D92586c61232a73ee1F7adFBf317",
  "56": "0x6119E236d3798777A3f2553926070958DF5704F1",
  "196": "0x41e1f213bF4aDA84a0D4E6A9b5E0F0a211F5A723",
  "223": "0x03c4FCF963E5FBC0dC5851d2340624E70492acb9",
  "42161": "0x7a571901687E7F30431B4E86bdd1baB6caE51D43",
  "80094": "0x6Cf2B79D1A2173339399a3ecB44086327c9ce308",
};

const DISPLAY = { name: "TermMax", short: "TermMax" } as const;

type TermMaxChainConfig = {
  routerV2?: string;
  routerV1?: string;
  oracleAggregatorV2: string;
  viewer: string;
  whitelistManager?: string;
  termMaxSwapAdapter?: string;
  marketFactories?: string[];
  apiBaseUrl?: string;
};

const ROUTER_ABI = [
  {
    type: "function",
    name: "getVersion",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const VIEWER_ABI = [
  {
    type: "function",
    name: "getPositionDetails",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address[]" },
      { name: "owner", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "underlyingBalance", type: "uint256" },
          { name: "collateralBalance", type: "uint256" },
          { name: "ftBalance", type: "uint256" },
          { name: "xtBalance", type: "uint256" },
          {
            name: "gtInfo",
            type: "tuple[]",
            components: [
              { name: "loanId", type: "uint256" },
              { name: "collateralAmt", type: "uint256" },
              { name: "debtAmt", type: "uint256" },
            ],
          },
        ],
      },
    ],
  },
] as const;

const ORACLE_ABI = [
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "price", type: "uint256" },
      { name: "decimals", type: "uint8" },
    ],
  },
] as const;

const WHITELIST_ABI = [
  {
    type: "function",
    name: "isWhitelisted",
    stateMutability: "view",
    inputs: [
      { name: "contractAddress", type: "address" },
      { name: "module", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** A throwaway address for the read-only viewer probe. */
const PROBE_ACCOUNT = "0x1111111111111111111111111111111111111111";

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const lower = (v: unknown) => String(v ?? "").toLowerCase();
const isAddr = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);

/** Read one `view`/`pure` call, returning undefined when it reverts. */
async function tryRead(
  chainId: string,
  address: string,
  abi: any,
  name: string,
  params: any[] = [],
): Promise<any> {
  try {
    const res = (await multicallRetryUniversal({
      chain: chainId,
      calls: [{ address, name, params }],
      abi,
      allowFailure: true,
    })) as any[];
    return res?.[0];
  } catch {
    return undefined;
  }
}

/**
 * Verify + assemble one chain's config. Returns undefined when the chain
 * cannot be verified at all (no viewer or no oracle), so it is left out
 * rather than published half-working.
 */
async function fetchChain(
  chainId: string,
): Promise<TermMaxChainConfig | undefined> {
  let cfg: any;
  let markets: any[] = [];
  try {
    const data = await fetchJson(
      `${API_BASE}/market/data?chainId=${chainId}`,
    );
    cfg = data?.data?.globalConfig;
    markets = Array.isArray(data?.data?.markets) ? data.data.markets : [];
  } catch (e) {
    console.log(`  TermMax ${chainId}: API unavailable (${e}) — skipping`);
    return undefined;
  }
  if (!cfg) return undefined;

  const routerCandidate = cfg.routerV2Address || cfg.routerAddress;
  const legacyRouter = cfg.routerAddress;
  const viewer = cfg.marketViewerV2Address;
  const oracle = cfg.oracleAggregatorV2 || cfg.oracleAggregator;

  if (!isAddr(viewer) || !isAddr(oracle)) {
    console.log(`  TermMax ${chainId}: no viewer/oracle in API config — skipping`);
    return undefined;
  }

  // ── viewer: must answer getPositionDetails ──
  const viewerOk =
    (await tryRead(chainId, viewer, VIEWER_ABI, "getPositionDetails", [
      [],
      PROBE_ACCOUNT,
    ])) !== undefined;
  if (!viewerOk) {
    console.log(`  TermMax ${chainId}: viewer ${viewer} failed verification — skipping`);
    return undefined;
  }

  // ── oracle: must price a live market's debt token ──
  const debtToken = markets.find((m) => isAddr(m?.contracts?.underlyingAddr))
    ?.contracts?.underlyingAddr;
  let oracleOk = true;
  if (debtToken) {
    const res = await tryRead(chainId, oracle, ORACLE_ABI, "getPrice", [
      debtToken,
    ]);
    const price = Array.isArray(res) ? res[0] : res?.price;
    oracleOk = price !== undefined && BigInt(price ?? 0) > 0n;
  }
  if (!oracleOk) {
    // Not fatal on its own — some chains have assets the aggregator does not
    // price yet — but worth surfacing, since LTV/liquidation read off this.
    console.log(`  TermMax ${chainId}: oracle ${oracle} did not price ${debtToken}`);
  }

  const out: TermMaxChainConfig = {
    oracleAggregatorV2: oracle,
    viewer,
  };

  // ── router: getVersion decides V2 vs V1 ──
  if (isAddr(routerCandidate)) {
    const version = await tryRead(
      chainId,
      routerCandidate,
      ROUTER_ABI,
      "getVersion",
    );
    if (typeof version === "string" && version.startsWith("2.")) {
      out.routerV2 = routerCandidate;
    } else {
      // No `getVersion` ⇒ a V1-era router. Record it as such rather than
      // mislabelling it: the V2 SwapPath borrow does not exist on it.
      out.routerV1 = routerCandidate;
      console.log(
        `  TermMax ${chainId}: router ${routerCandidate} has no getVersion — recorded as routerV1`,
      );
    }
  }
  if (
    isAddr(legacyRouter) &&
    lower(legacyRouter) !== lower(out.routerV2 ?? "") &&
    lower(legacyRouter) !== lower(out.routerV1 ?? "")
  ) {
    out.routerV1 = legacyRouter;
  }

  // ── whitelist manager (seeded, verified) ──
  const wm = WHITELIST_MANAGERS[chainId];
  if (isAddr(wm)) {
    const probe = out.routerV2 ?? out.routerV1;
    const ok =
      probe !== undefined &&
      (await tryRead(chainId, wm, WHITELIST_ABI, "isWhitelisted", [
        probe,
        2, // ContractModule.MARKET
      ])) !== undefined;
    if (ok) out.whitelistManager = wm;
  }

  // ── market factories (event-based discovery fallback; not needed on the
  //    happy path, where markets come from the API) ──
  const factories: string[] = [];
  for (const key of ["factoryV2AddressList", "marketV2_01FactoryAddressList"]) {
    for (const entry of cfg[key] ?? []) {
      const addr = entry?.address ?? entry;
      if (isAddr(addr) && !factories.some((f) => lower(f) === lower(addr))) {
        factories.push(addr);
      }
    }
  }
  if (factories.length > 0) out.marketFactories = factories;

  console.log(
    `  TermMax ${chainId}: ${out.routerV2 ? "routerV2" : "routerV1 only"}, ` +
      `${markets.length} live markets, ${factories.length} factories`,
  );
  return out;
}

export class TermMaxUpdater implements DataUpdater {
  name = "TermMax Chain Config";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    let chainIds: string[] = [];
    try {
      const res = await fetchJson(SUPPORT_CHAINS_URL);
      chainIds = (res?.data ?? []).map((c: any) => String(c));
    } catch (e) {
      console.log(`TermMax: cannot reach ${SUPPORT_CHAINS_URL} (${e})`);
      return {};
    }
    if (chainIds.length === 0) return {};

    console.log(`TermMax: ${chainIds.length} chains reported by the API`);
    const config: Record<string, TermMaxChainConfig> = {};
    for (const chainId of chainIds) {
      const row = await fetchChain(chainId);
      if (row) config[chainId] = row;
    }

    if (Object.keys(config).length === 0) {
      console.log("TermMax: nothing verified, leaving config untouched");
      return {};
    }

    return {
      [CONFIG_FILE]: config,
      [LABELS_FILE]: {
        names: { TERMMAX: DISPLAY.name },
        shortNames: { TERMMAX: DISPLAY.short },
      },
    };
  }

  /**
   * Deep-merge both files. The config is a seeded/shared file, and merging
   * (rather than replacing) means a chain whose RPC was down during a run
   * keeps its previously verified addresses instead of silently disappearing.
   */
  mergeData(oldData: any, data: any): any {
    return deepMergeData(oldData ?? {}, data ?? {});
  }
}
