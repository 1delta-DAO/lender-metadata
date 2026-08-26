// ============================================================================
// Flying Tulip — asset roster discovery.
//
// Flying Tulip is a CROSS-MARGIN lender: ONE `PositionsManager` per chain holds
// every asset, and health is a single global check over the whole account. So
// there are no "markets" to enumerate — the roster is the ASSET LIST, and the
// lender key is the bare `FLYING_TULIP` on both chains (the Exactly shape).
//
// DISCOVERY IS BY LOG, NOT BY VIEW. `ConfigRegistry` exposes no `assets()` /
// `assetCount()` getter — which is why the 2026-08-08 assessment concluded a
// hand-curated allowlist was mandatory. That conclusion was wrong: the registry
// emits `AssetSet(address indexed asset, AssetCfg cfg)` on every listing and
// every re-config, so one topic-filtered `eth_getLogs` over full history
// enumerates the book exactly. Deduplicate by asset (17 logs → 7 assets on
// Ethereum; 18 → 8 on Sonic) and take the LIVE `assetCfg` for the values —
// never the log payload, which is whatever the config was at emission time.
//
// There is no removal event. An asset leaves the book by `enabled: false`, or
// in practice by being frozen in place (Sonic's USSD carries 1-wei caps plus
// deposit+borrow pauses while still holding $25k of supply and $3.6k of debt —
// repay/withdraw only). Both states are reported rather than filtered, because
// a user holding a position in a frozen asset still needs it to render.
//
// Self-contained by the `fetch/curvance/labels.ts` precedent: inline ABIs,
// inline addresses, raw viem. @1delta/abis and @1delta/data-sdk do not carry
// Flying Tulip until a publish lands, and importing them would make this
// generator unrunnable in the meantime.
// ============================================================================

import {
  createPublicClient,
  http,
  fallback,
  parseAbi,
  keccak256,
  toHex,
  type Address,
  type PublicClient,
} from "viem";

/** Same CREATE2 addresses on Ethereum and Sonic — verified on-chain. */
export const FT_CONFIG_REGISTRY: Address =
  "0xA8777c3D446fa7F0b0FC97a80C1Ea1d37F1ca33E";
export const FT_LENDING_LENS: Address =
  "0x3682168023E6bA8D1F995FdA1D920827C5A8A43E";

export const FT_CHAIN_IDS = [1, 146] as const;
export type FtChainId = (typeof FT_CHAIN_IDS)[number];

/**
 * Endpoints chosen for `eth_getLogs` REACH, not latency — this is the repo's
 * standing "getLogs on free RPCs lies" rule. Both were validated against a
 * known-populated query before being pinned here (2026-08-25):
 *
 *  - Ethereum: the Tenderly public gateway is the one endpoint that answers a
 *    full-history topic-filtered scan in a SINGLE request. `eth.drpc.org` caps
 *    at 9k blocks and `ethereum-rpc.publicnode.com` rejects the whole class as
 *    "archive requests".
 *  - Sonic: the official `rpc.soniclabs.com` serves full history. `sonic.drpc.org`
 *    refuses ranges over 10k blocks (free plan) and publicnode caps at 50k.
 */
const RPCS: Record<FtChainId, string[]> = {
  1: ["https://gateway.tenderly.co/public/mainnet", "https://eth.drpc.org"],
  146: ["https://rpc.soniclabs.com"],
};

/**
 * `AssetSet(address,(address,uint16,bool,address,bool,bool))`.
 *
 * The tuple expansion is the struct `IConfigRegistry.AssetCfg`
 * `(irm, mmBps, enabled, ftYieldWrapper, borrowable, collateral)` — note
 * `ftYieldWrapper` sits BETWEEN `enabled` and `borrowable`, and the lens's
 * `assetCfg()` view drops it. Getting that field order wrong changes the topic
 * hash and the scan silently returns nothing.
 */
const ASSET_SET_TOPIC = keccak256(
  toHex("AssetSet(address,(address,uint16,bool,address,bool,bool))"),
);

const LENS_ABI = parseAbi([
  "function assetCfg(address) view returns (address irm, uint16 mmBps, bool enabled, bool borrowable, bool isCollateral)",
  "function supplyCap(address) view returns (uint256)",
  "function borrowCap(address) view returns (uint256)",
  "function depositPaused(address) view returns (bool)",
  "function withdrawPaused(address) view returns (bool)",
  "function borrowPaused(address) view returns (bool)",
  "function priceAndDecimals(address) view returns (uint256 pxWad, uint8 dec)",
]);

const CFG_ABI = parseAbi([
  "function marginHfTargetBps() view returns (uint16)",
  "function marginHfSafeBps() view returns (uint16)",
  "function marginMinEquityUSDWad() view returns (uint256)",
  "function oracleRouter() view returns (address)",
]);

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export interface FlyingTulipAsset {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Maintenance-margin rate, BPS. Charged on the DEBT leg too — see below. */
  mmBps: number;
  enabled: boolean;
  borrowable: boolean;
  collateral: boolean;
  irm: string;
  supplyCap: string;
  borrowCap: string;
  depositPaused: boolean;
  withdrawPaused: boolean;
  borrowPaused: boolean;
  /**
   * Whether the protocol's own oracle prices this asset AT ALL.
   *
   * `FT` does not (`priceUSD` reverts `0x64bb3412` on both chains) — and it is
   * also `collateral: false, mmBps: 0`, so it contributes nothing to equity or
   * maintenance. It is in the book only as a supply/emission venue.
   */
  priceable: boolean;
}

export interface FlyingTulipChain {
  /** Open gate: a new borrow/withdraw must leave HF at or above this. */
  marginHfSafeBps: number;
  /** LIQUIDATION TRIGGER — 12500, i.e. HF < 1.25. NOT 1.0. */
  marginHfTargetBps: number;
  /**
   * Minimum account equity, USD-WAD, enforced while any debt exists.
   *
   * PER-CHAIN and NOT the same on both: $250 on Ethereum, $10 on Sonic
   * (read 2026-08-25). Never hardcode this — it is one ungated Safe call away
   * from changing, and the two chains already disagree.
   */
  marginMinEquityUSDWad: string;
  oracleRouter: string;
  assets: FlyingTulipAsset[];
}

export type FlyingTulipRoster = Record<string, FlyingTulipChain>;

function clientFor(chainId: FtChainId): PublicClient {
  return createPublicClient({
    transport: fallback(RPCS[chainId].map((u) => http(u, { timeout: 60_000 }))),
  }) as PublicClient;
}

/** Enumerate every asset the ConfigRegistry has ever listed on `chainId`. */
export async function discoverFlyingTulipAssets(
  chainId: FtChainId,
): Promise<Address[]> {
  const client = clientFor(chainId);
  const logs = (await client.request({
    method: "eth_getLogs" as any,
    params: [
      {
        address: FT_CONFIG_REGISTRY,
        topics: [ASSET_SET_TOPIC],
        fromBlock: "0x0",
        toBlock: "latest",
      },
    ] as any,
  } as any)) as { topics: string[] }[];

  const seen = new Set<string>();
  for (const log of logs) {
    const t = log.topics?.[1];
    if (!t) continue;
    seen.add(("0x" + t.slice(26)).toLowerCase());
  }
  return [...seen] as Address[];
}

/** Read the live config + state for a discovered roster. */
export async function fetchFlyingTulipChain(
  chainId: FtChainId,
): Promise<FlyingTulipChain> {
  const client = clientFor(chainId);
  const addresses = await discoverFlyingTulipAssets(chainId);
  if (addresses.length === 0) {
    // Fail LOUDLY. There is no cached fallback and no view-based enumeration,
    // so "zero assets" is far more likely to be a log-endpoint problem than a
    // delisting of the entire book — and writing an empty roster would leave
    // the file looking correctly updated. (The Curvance precedent.)
    throw new Error(
      `Flying Tulip: AssetSet scan returned no logs on chain ${chainId} — refusing to write an empty roster.`,
    );
  }

  const read = <T>(
    address: Address,
    abi: any,
    functionName: string,
    args?: any[],
  ) => client.readContract({ address, abi, functionName, args }) as Promise<T>;

  const [safe, target, minEquity, oracleRouter] = await Promise.all([
    read<number>(FT_CONFIG_REGISTRY, CFG_ABI, "marginHfSafeBps"),
    read<number>(FT_CONFIG_REGISTRY, CFG_ABI, "marginHfTargetBps"),
    read<bigint>(FT_CONFIG_REGISTRY, CFG_ABI, "marginMinEquityUSDWad"),
    read<string>(FT_CONFIG_REGISTRY, CFG_ABI, "oracleRouter"),
  ]);

  const assets: FlyingTulipAsset[] = [];
  for (const address of addresses) {
    const [symbol, name, decimals] = await Promise.all([
      read<string>(address, ERC20_ABI, "symbol").catch(() => "?"),
      read<string>(address, ERC20_ABI, "name").catch(() => "?"),
      read<number>(address, ERC20_ABI, "decimals").catch(() => 18),
    ]);
    const cfg = await read<[string, number, boolean, boolean, boolean]>(
      FT_LENDING_LENS,
      LENS_ABI,
      "assetCfg",
      [address],
    );
    const [supplyCap, borrowCap, depositPaused, withdrawPaused, borrowPaused] =
      await Promise.all([
        read<bigint>(FT_LENDING_LENS, LENS_ABI, "supplyCap", [address]),
        read<bigint>(FT_LENDING_LENS, LENS_ABI, "borrowCap", [address]),
        read<boolean>(FT_LENDING_LENS, LENS_ABI, "depositPaused", [address]),
        read<boolean>(FT_LENDING_LENS, LENS_ABI, "withdrawPaused", [address]),
        read<boolean>(FT_LENDING_LENS, LENS_ABI, "borrowPaused", [address]),
      ]);

    // Probe the price PER ASSET. `pricesUSD(address[])` on the lens loops the
    // oracle without catching, so ONE unpriceable asset reverts the whole
    // batch — and FT is exactly that on both chains. Never batch this.
    let priceable = true;
    try {
      await read(FT_LENDING_LENS, LENS_ABI, "priceAndDecimals", [address]);
    } catch {
      priceable = false;
    }

    assets.push({
      address: address.toLowerCase(),
      symbol,
      name,
      decimals: Number(decimals),
      irm: String(cfg[0]).toLowerCase(),
      mmBps: Number(cfg[1]),
      enabled: Boolean(cfg[2]),
      borrowable: Boolean(cfg[3]),
      collateral: Boolean(cfg[4]),
      supplyCap: supplyCap.toString(),
      borrowCap: borrowCap.toString(),
      depositPaused,
      withdrawPaused,
      borrowPaused,
      priceable,
    });
  }

  assets.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    marginHfSafeBps: Number(safe),
    marginHfTargetBps: Number(target),
    marginMinEquityUSDWad: minEquity.toString(),
    oracleRouter: String(oracleRouter).toLowerCase(),
    assets,
  };
}

export async function fetchFlyingTulipRoster(): Promise<FlyingTulipRoster> {
  const out: FlyingTulipRoster = {};
  for (const chainId of FT_CHAIN_IDS) {
    out[String(chainId)] = await fetchFlyingTulipChain(chainId);
  }
  return out;
}

/**
 * Labels. Flying Tulip fans out to NO per-market keys — cross-margin means one
 * bare `FLYING_TULIP` key covers every asset on every chain — so this is a
 * two-entry backfill, not a roster walk.
 */
export function buildFlyingTulipLabels(): {
  names: Record<string, string>;
  shortNames: Record<string, string>;
} {
  return {
    names: { FLYING_TULIP: "Flying Tulip" },
    shortNames: { FLYING_TULIP: "Flying Tulip" },
  };
}
