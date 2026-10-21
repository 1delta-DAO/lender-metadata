// ============================================================================
// Build config/resupply.json — Resupply's per-chain deployment row.
//
// @1delta/data-sdk ships the same row as a built-in seed
// (`RESUPPLY_ETHEREUM_CONFIG`), and `resupplyConfigFor` prefers a published row
// over it. This file exists so that a redeploy is a metadata publish instead of
// an SDK release: on 2026-10-20 Resupply replaced both RouterSwappers (the old
// pair reads `approvalsRevoked == true` and is whitelisted on no pair), and
// every enso/lifi loop answered `BadSwapper` until the seed was re-pinned and
// re-released.
//
// A published row REPLACES the built-in one (no field merge in data-sdk), so
// this writes EVERY field. Everything that the registry can answer is read
// live; the rest is carried as a constant here:
//
//   registry          the discovery root (also hardcoded in RouterSwapper)
//   reusd             Registry.token()
//   utilities, redemptionHandler, liquidationHandler, insurancePool, sreusd,
//   priceWatcher      Registry.getAddress(<KEY>)
//   reusdOracle       PriceWatcher.oracle() — NOT the registry's
//                     `REUSD_ORACLE` key, which names a different contract;
//                     the protocol's borrow rate reads the PriceWatcher's.
//   ensoSwapper,
//   lifiSwapper       Registry.defaultSwappers(i) matched by `name()`, skipping
//                     any whose `approvalsRevoked()` is true
//   curveSwapper      the built-in Curve `Swapper` (defaultSwappers(0)); it has
//                     no `name()`, so it is a constant, checked to still be a
//                     default swapper
//
// Any failed read aborts the whole row: writing nothing keeps the last good
// file, while a partial row would silently drop a field for every consumer.
// ============================================================================

import {
  createPublicClient,
  http,
  fallback,
  getAddress,
  type Address,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { mergeData as deepMergeData } from "../../utils.js";
import { RESUPPLY_CHAIN_ID, RESUPPLY_REGISTRY } from "./labels.js";

const CONFIG_FILE = "./config/resupply.json";

const ETHEREUM_RPCS = [
  "https://eth.merkle.io",
  "https://ethereum-rpc.publicnode.com",
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
];

/** The built-in Curve `Swapper` — no `name()`, so it cannot be matched. */
const CURVE_SWAPPER: Address = "0x042f48346be16Be381190a7397A80808243f3b2e";

/** Registry key → config field, for every singleton the registry names. */
const REGISTRY_KEYS = {
  utilities: "UTILITIES",
  redemptionHandler: "REDEMPTION_HANDLER",
  liquidationHandler: "LIQUIDATION_HANDLER",
  insurancePool: "INSURANCE_POOL",
  sreusd: "SREUSD",
  priceWatcher: "PRICE_WATCHER",
} as const;

/** `name()` of the RouterSwappers, as deployed. */
const SWAPPER_NAMES = {
  ensoSwapper: "Resupply Swapper: ENSO",
  lifiSwapper: "Resupply Swapper: LI.FI",
} as const;

/** `defaultSwappers` has no length getter; it is a short array. */
const MAX_DEFAULT_SWAPPERS = 32;

const ABI = [
  {
    name: "token",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "getAddress",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "defaultSwappers",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "oracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "approvalsRevoked",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface ResupplyConfigRow {
  registry: string;
  reusd: string;
  utilities: string;
  curveSwapper: string;
  ensoSwapper: string;
  lifiSwapper: string;
  redemptionHandler: string;
  liquidationHandler: string;
  insurancePool: string;
  sreusd: string;
  priceWatcher: string;
  reusdOracle: string;
  debtDecimals: number;
}

function client(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: fallback(ETHEREUM_RPCS.map((u) => http(u))),
  }) as PublicClient;
}

const isZero = (a: string) => /^0x0{40}$/i.test(a);

/** Every entry of `Registry.defaultSwappers`, read until the index reverts. */
async function readDefaultSwappers(pc: PublicClient): Promise<Address[]> {
  const out: Address[] = [];
  for (let i = 0; i < MAX_DEFAULT_SWAPPERS; i++) {
    try {
      const a = (await pc.readContract({
        address: RESUPPLY_REGISTRY,
        abi: ABI,
        functionName: "defaultSwappers",
        args: [BigInt(i)],
      })) as Address;
      out.push(getAddress(a));
    } catch {
      break;
    }
  }
  return out;
}

/**
 * The live RouterSwapper for each aggregator: the default swapper whose
 * `name()` matches and whose `approvalsRevoked()` is false. A revoked one is
 * whitelisted on no pair, so publishing it is exactly the `BadSwapper` bug.
 */
async function resolveRouterSwappers(
  pc: PublicClient,
  swappers: Address[],
): Promise<Record<keyof typeof SWAPPER_NAMES, Address>> {
  const found: Partial<Record<keyof typeof SWAPPER_NAMES, Address>> = {};
  for (const s of swappers) {
    let name: string;
    try {
      name = (await pc.readContract({
        address: s,
        abi: ABI,
        functionName: "name",
      })) as string;
    } catch {
      continue; // the Curve Swapper has no name()
    }
    const field = (
      Object.keys(SWAPPER_NAMES) as (keyof typeof SWAPPER_NAMES)[]
    ).find((k) => SWAPPER_NAMES[k] === name);
    if (!field) continue;
    const revoked = (await pc.readContract({
      address: s,
      abi: ABI,
      functionName: "approvalsRevoked",
    })) as boolean;
    if (revoked) {
      console.log(`Resupply: ${name} ${s} has approvalsRevoked — skipped`);
      continue;
    }
    if (found[field] && found[field] !== s) {
      throw new Error(
        `two live "${name}" swappers: ${found[field]} and ${s} — pick by hand`,
      );
    }
    found[field] = s;
  }
  for (const k of Object.keys(SWAPPER_NAMES) as (keyof typeof SWAPPER_NAMES)[]) {
    if (!found[k]) throw new Error(`no live "${SWAPPER_NAMES[k]}" swapper`);
  }
  return found as Record<keyof typeof SWAPPER_NAMES, Address>;
}

/** Resolve the full row on-chain. Throws on any failed or zero read. */
export async function discoverResupplyConfig(): Promise<ResupplyConfigRow> {
  const pc = client();
  const read = async (
    address: Address,
    functionName: "token" | "oracle",
  ): Promise<Address> =>
    getAddress(
      (await pc.readContract({ address, abi: ABI, functionName })) as Address,
    );

  const reusd = await read(RESUPPLY_REGISTRY, "token");

  const keyed = {} as Record<keyof typeof REGISTRY_KEYS, Address>;
  for (const [field, key] of Object.entries(REGISTRY_KEYS)) {
    keyed[field as keyof typeof REGISTRY_KEYS] = getAddress(
      (await pc.readContract({
        address: RESUPPLY_REGISTRY,
        abi: ABI,
        functionName: "getAddress",
        args: [key],
      })) as Address,
    );
  }

  const reusdOracle = await read(keyed.priceWatcher, "oracle");

  const swappers = await readDefaultSwappers(pc);
  if (!swappers.includes(CURVE_SWAPPER)) {
    throw new Error(
      `Curve Swapper ${CURVE_SWAPPER} is no longer a default swapper (${swappers.join(", ")}) — update CURVE_SWAPPER`,
    );
  }
  const routers = await resolveRouterSwappers(pc, swappers);

  const row: ResupplyConfigRow = {
    registry: getAddress(RESUPPLY_REGISTRY),
    reusd,
    ...keyed,
    reusdOracle,
    curveSwapper: CURVE_SWAPPER,
    ...routers,
    debtDecimals: 18,
  };
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && isZero(v)) {
      throw new Error(`Resupply: ${k} resolved to the zero address`);
    }
  }
  return row;
}

/**
 * Daily-run wrapper (`update:dataset`). A failed discovery writes NOTHING, so
 * the last published row (and behind it data-sdk's seed) stays in force.
 */
export class ResupplyConfigUpdater {
  name = "Resupply Config";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    try {
      const row = await discoverResupplyConfig();
      return {
        [CONFIG_FILE]: { RESUPPLY: { [String(RESUPPLY_CHAIN_ID)]: row } },
      };
    } catch (e) {
      console.log(
        "Resupply: config discovery failed — keeping config/resupply.json:",
        (e as any)?.shortMessage ?? (e as any)?.message ?? e,
      );
      return {};
    }
  }

  mergeData(oldData: any, data: any): any {
    return deepMergeData(oldData ?? {}, data ?? {});
  }
}
