// ============================================================================
// Build display labels for Resupply pairs.
//
// Like Curvance, Resupply has NO file in this repo: its roster is discovered
// from `ResupplyRegistry.getAllPairAddresses()` at runtime (governance adds
// pairs — 7 appeared between the docs' published list and 2026-08 — and retires
// them by zeroing `borrowLimit` rather than removing them), and the deployment
// seed is a built-in in @1delta/data-sdk. So labels are the only Resupply
// artifact this repo owns, and this module is their sole source.
//
// Self-contained (inline address, inline ABI, raw viem) for the same reason as
// the Curvance builder: the published @1delta/abis and @1delta/data-sdk this
// repo depends on do not carry Resupply yet, so importing them would make the
// generator unrunnable until a publish lands.
//
// WHY THE LABEL IS THE *WRAPPED* MARKET
//
// A Resupply pair mints reUSD against ANOTHER lender's supply position, so its
// two rows are `reUSD` (debt) and `crvUSD` (collateral, published in the
// underlying) on EVERY CurveLend pair. The usual `<debt> / <collateral>` shape
// would therefore render all 16 CurveLend pairs identically. The only thing
// that distinguishes them is the market being wrapped, which is exactly what
// the pair's own `name()` carries:
//
//   "Resupply Pair (CurveLend: crvUSD/sfrxUSD) - 1"
//        -> names[RESUPPLY_1_<PAIR>]      = "Resupply CurveLend: crvUSD/sfrxUSD"
//        -> shortNames[RESUPPLY_1_<PAIR>] = "CurveLend: crvUSD/sfrxUSD"
//
// The family prefix and the redeploy counter both have to survive, because the
// roster genuinely repeats: sDOLA appears three times (CurveLend, a CurveLend
// redeploy, CurveLendV2), tBTC twice, WBTC three times across both families.
// `crvUSD/sDOLA` alone would name three different markets.
//
// The `- N` suffix is dropped when it is `1` (the common case) and kept
// otherwise, so only the redeploys carry it.
//
// The string is deliberately IDENTICAL to `resupplyMarketLabel()` in
// margin-fetcher, which sets the same text on `config[0].label`. One canonical
// label, two producers, no contradiction — if that helper changes, change this
// with it.
// ============================================================================

import {
  createPublicClient,
  http,
  fallback,
  type Address,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";

/** Resupply is Ethereum-only. */
export const RESUPPLY_CHAIN_ID = 1;

/** The one discovery root — also the address `RouterSwapper` hardcodes. */
export const RESUPPLY_REGISTRY: Address =
  "0x10101010E0C3171D894B71B3400668aF311e7D94";

const ETHEREUM_RPCS = [
  "https://eth.merkle.io",
  "https://ethereum-rpc.publicnode.com",
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
];

const REGISTRY_ABI = [
  {
    name: "getAllPairAddresses",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
] as const;

const PAIR_ABI = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export interface ResupplyPair {
  pair: string;
  /** Raw on-chain `name()`, kept so a shape change is visible in the log. */
  rawName: string;
  /** The parenthesized market name, with the redeploy suffix when not `1`. */
  label: string;
}

function client(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: fallback(ETHEREUM_RPCS.map((u) => http(u))),
  }) as PublicClient;
}

/**
 * `Resupply Pair (CurveLend: crvUSD/sfrxUSD) - 2` -> `CurveLend: crvUSD/sfrxUSD - 2`.
 *
 * Returns undefined rather than inventing a name when the shape does not match:
 * a pair whose `name()` stops looking like this should fall back to its raw key
 * (and show up in the run log), not be silently mislabeled.
 */
export function resupplyLabelFromName(rawName: string): string | undefined {
  const inner = rawName.match(/\(([^)]+)\)/)?.[1]?.trim();
  if (!inner) return undefined;
  const suffix = rawName.match(/\)\s*-\s*(\d+)\s*$/)?.[1];
  return suffix && suffix !== "1" ? `${inner} - ${suffix}` : inner;
}

/** Key scheme, mirroring `resupplyLenderKey` in margin-fetcher. */
export const resupplyLenderKey = (pair: string) =>
  `RESUPPLY_${RESUPPLY_CHAIN_ID}_${pair.replace(/^0x/i, "").toUpperCase()}`;

/**
 * Discover every registered pair and read its name.
 *
 * Retired pairs (`borrowLimit == 0`) are deliberately INCLUDED: a user still
 * holding a position in one needs it named, and the registry never drops them.
 */
export async function discoverResupplyPairs(): Promise<ResupplyPair[]> {
  const pc = client();

  const addresses = (await pc.readContract({
    address: RESUPPLY_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "getAllPairAddresses",
  })) as readonly Address[];

  const out: ResupplyPair[] = [];
  for (const pair of addresses ?? []) {
    try {
      const rawName = (await pc.readContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "name",
      })) as string;
      const label = resupplyLabelFromName(rawName);
      if (!label) {
        console.log(`Resupply: ${pair} name "${rawName}" — unrecognised shape`);
        continue;
      }
      out.push({ pair, rawName, label });
    } catch (e) {
      console.log(
        `Resupply: ${pair} name() failed:`,
        (e as any)?.shortMessage ?? (e as any)?.message ?? e,
      );
    }
  }
  return out;
}

export function buildResupplyLabels(pairs: ResupplyPair[]): {
  names: Record<string, string>;
  shortNames: Record<string, string>;
} {
  const names: Record<string, string> = { RESUPPLY: "Resupply" };
  const shortNames: Record<string, string> = { RESUPPLY: "Resupply" };
  for (const p of pairs) {
    const key = resupplyLenderKey(p.pair);
    names[key] = `Resupply ${p.label}`;
    shortNames[key] = p.label;
  }
  return { names, shortNames };
}
