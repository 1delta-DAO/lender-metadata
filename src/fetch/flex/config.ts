// ============================================================================
// Build config/flex.json — the Flex (flexmeow.com) market roster — and the
// per-market labels in data/lender-labels.json.
//
// Flex is Ethereum-only. Every market is one TroveManager (an EIP-1167 clone
// from the Flex factory) registered in the Flex `Registry`. The roster is the
// markets the Registry marks ENDORSED (`market_status == 1`); status 2 is
// deprecated (the v1 yvUSD/USDC market, the first siUSD/USDC market) and is
// skipped. Every address of a market comes from the TroveManager's own
// getters, so a newly endorsed market lands here on the next run without an
// SDK release (stcUSD/USDC was missed that way on 2026-11-25).
//
// @1delta/data-sdk carries the same roster as a built-in seed
// (`FLEX_ETHEREUM_CONFIG`), and `flexConfigFor` prefers a published row with
// markets over it, whole (no field merge). So this writes EVERY field, and any
// failed or zero read aborts the run: writing nothing keeps the last good file.
//
// `leverageZapper` is a constant: the zapper exposes no getter tying it to a
// market, and the current one serves every endorsed market (it checks the
// Registry). The previous zapper (`0xbF3E99…`) served only the v1 market.
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

export const FLEX_CHAIN_ID = 1;

export const FLEX_REGISTRY: Address =
  "0x9117440a7D03238905d1C8908157Bd7a547c77c8";

export const FLEX_LEVERAGE_ZAPPER: Address =
  "0x1c0FEB0b97aD3938A0f308CB574D3b56998f0143";

const CONFIG_FILE = "./config/flex.json";
const LABELS_FILE = "./data/lender-labels.json";

/** `market_status` value of an endorsed market. */
const ENDORSED = 1n;

const ETHEREUM_RPCS = [
  "https://eth.merkle.io",
  "https://ethereum-rpc.publicnode.com",
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
];

const addressView = (name: string) =>
  ({
    name,
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  }) as const;

const REGISTRY_ABI = [
  {
    name: "get_all_markets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    name: "market_status",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** TroveManager getter → roster field. */
const TM_FIELDS = {
  lender: "lender",
  sortedTroves: "sorted_troves",
  dutchDesk: "dutch_desk",
  priceOracle: "price_oracle",
  collateral: "collateral_token",
  borrowToken: "borrow_token",
} as const;

const TM_ABI = Object.values(TM_FIELDS).map(addressView);

const SYMBOL_ABI = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

/** Mirrors data-sdk's `FlexMarketEntry`. */
export interface FlexMarketRow {
  troveManager: string;
  lender: string;
  sortedTroves: string;
  dutchDesk: string;
  leverageZapper: string;
  priceOracle: string;
  collateral: string;
  borrowToken: string;
  collateralSymbol: string;
  borrowSymbol: string;
}

export interface FlexConfigChain {
  registry: string;
  markets: FlexMarketRow[];
}

function client(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: fallback(ETHEREUM_RPCS.map((u) => http(u))),
  }) as PublicClient;
}

const isZero = (a: string) => /^0x0{40}$/i.test(a);

/** Resolve the endorsed roster on-chain. Throws on any failed or zero read. */
export async function discoverFlexConfig(): Promise<FlexConfigChain> {
  const pc = client();

  const all = (await pc.readContract({
    address: FLEX_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "get_all_markets",
  })) as Address[];
  if (all.length === 0) throw new Error("Registry lists no markets");

  const statuses = await pc.multicall({
    allowFailure: false,
    contracts: all.map((m) => ({
      address: FLEX_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "market_status" as const,
      args: [m],
    })),
  });
  const endorsed = all.filter((_, i) => (statuses[i] as bigint) === ENDORSED);
  if (endorsed.length === 0) throw new Error("no endorsed market");

  const fields = Object.keys(TM_FIELDS) as (keyof typeof TM_FIELDS)[];
  const reads = (await pc.multicall({
    allowFailure: false,
    contracts: endorsed.flatMap((tm) =>
      fields.map((f) => ({
        address: tm,
        abi: TM_ABI,
        functionName: TM_FIELDS[f],
      })),
    ),
  })) as Address[];

  const partial = endorsed.map((tm, i) => {
    const row = { troveManager: getAddress(tm) } as Record<string, string>;
    fields.forEach((f, j) => {
      row[f] = getAddress(reads[i * fields.length + j]);
    });
    return row;
  });

  const tokens = [
    ...new Set(partial.flatMap((r) => [r.collateral, r.borrowToken])),
  ] as Address[];
  const symbols = (await pc.multicall({
    allowFailure: false,
    contracts: tokens.map((t) => ({
      address: t,
      abi: SYMBOL_ABI,
      functionName: "symbol" as const,
    })),
  })) as string[];
  const symbolOf = new Map(tokens.map((t, i) => [t, symbols[i]]));

  const markets: FlexMarketRow[] = partial.map((r) => ({
    troveManager: r.troveManager,
    lender: r.lender,
    sortedTroves: r.sortedTroves,
    dutchDesk: r.dutchDesk,
    leverageZapper: FLEX_LEVERAGE_ZAPPER,
    priceOracle: r.priceOracle,
    collateral: r.collateral,
    borrowToken: r.borrowToken,
    collateralSymbol: symbolOf.get(r.collateral as Address)!,
    borrowSymbol: symbolOf.get(r.borrowToken as Address)!,
  }));

  for (const m of markets) {
    for (const [k, v] of Object.entries(m)) {
      if (!v) throw new Error(`Flex ${m.troveManager}: empty ${k}`);
      if (isZero(v)) throw new Error(`Flex ${m.troveManager}: ${k} is zero`);
    }
  }
  return { registry: getAddress(FLEX_REGISTRY), markets };
}

/** `FLEX_<chainId>_<TROVE_MANAGER_HEX_UPPER>` — data-sdk's `flexMarketKey`. */
export const flexMarketKey = (troveManager: string): string =>
  `FLEX_${FLEX_CHAIN_ID}_${troveManager.replace(/^0x/i, "").toUpperCase()}`;

export function buildFlexLabels(markets: FlexMarketRow[]): {
  names: Record<string, string>;
  shortNames: Record<string, string>;
} {
  const names: Record<string, string> = { FLEX: "Flex" };
  const shortNames: Record<string, string> = { FLEX: "Flex" };
  for (const m of markets) {
    const pair = `${m.borrowSymbol} / ${m.collateralSymbol}`;
    names[flexMarketKey(m.troveManager)] = `Flex ${pair}`;
    shortNames[flexMarketKey(m.troveManager)] = pair;
  }
  return { names, shortNames };
}

/**
 * Daily-run wrapper (`update:dataset`). A failed discovery writes NOTHING, so
 * the last published roster (and behind it data-sdk's seed) stays in force.
 */
export class FlexConfigUpdater {
  name = "Flex Config";
  defaults = {};

  async fetchData(): Promise<{ [file: string]: any }> {
    try {
      const chain = await discoverFlexConfig();
      const labels = buildFlexLabels(chain.markets);
      return {
        [CONFIG_FILE]: { FLEX: { [String(FLEX_CHAIN_ID)]: chain } },
        [LABELS_FILE]: labels,
      };
    } catch (e) {
      console.log(
        "Flex: config discovery failed — keeping config/flex.json:",
        (e as any)?.shortMessage ?? (e as any)?.message ?? e,
      );
      return {};
    }
  }

  // `markets` is an array, which the merge REPLACES, so a market the Registry
  // stops endorsing leaves the roster.
  mergeData(oldData: any, data: any): any {
    return deepMergeData(oldData ?? {}, data ?? {});
  }
}
