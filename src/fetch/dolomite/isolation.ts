import { createPublicClient, http } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { DOLOMITE_FALLBACK_RPCS } from "./constants.js";
import { DOLOMITE_ISOLATION_CONVERTERS } from "./isolation-converters.js";

/**
 * Wrapper / unwrapper roster per isolation-mode factory — see
 * `isolation-converters.ts` (vendored from the zap SDK). Every entry is
 * re-validated on-chain (`isTokenConverterTrusted`) on each run and an
 * untrusted or unknown converter is written as `null` — a consumer must then
 * refuse the loop rather than emit a zap that reverts `Invalid isolation mode
 * wrapper`. Re-snapshot when Dolomite lists a new isolation market.
 */
const CONVERTER_SEED = DOLOMITE_ISOLATION_CONVERTERS;

/** What Dolomite's routers and `GenericTraderProxyV2Lib` test `name()` against. */
const ISOLATION_PREFIX = "Dolomite Isolation:";
const FS_GLP_NAME = "Dolomite: Fee + Staked GLP";

export interface DolomiteIsolationMarket {
  /** The market token = the `IsolationModeVaultFactory`. */
  factory: string;
  /** `UNDERLYING_TOKEN()` — what the user actually deposits / receives. */
  underlying: string;
  underlyingSymbol: string;
  underlyingDecimals: number;
  /** `allowableDebtMarketIds()`; EMPTY = unrestricted. */
  allowableDebtMarketIds: string[];
  /** `allowableCollateralMarketIds()`; EMPTY = unrestricted. */
  allowableCollateralMarketIds: string[];
  /**
   * Trusted `IsolationModeWrapperTrader` (TraderType 3, last zap hop) /
   * `IsolationModeUnwrapperTrader` (TraderType 2, first hop). `null` = no
   * loop route through this market (untrusted, unknown, or dead market).
   */
  wrapper: string | null;
  unwrapper: string | null;
  /** MarketIds the wrapper accepts as input (`isValidInputToken`). */
  wrapperInputMarketIds: string[];
  /** MarketIds the unwrapper can pay out (`isValidOutputToken`). */
  unwrapperOutputMarketIds: string[];
  /**
   * GMX V2 / GLV: the wrap is a GMX deposit executed by a keeper, the vault is
   * frozen until then, and `executionFeeWei` must be sent as `msg.value` on
   * the zap AND once per borrow account on `openBorrowPosition`. Unwrapping is
   * `vault.initiateUnwrapping`, never a user zap.
   */
  async: boolean;
  executionFeeWei: string | null;
}

export type DolomiteIsolationChain = Record<string, DolomiteIsolationMarket>;

const erc20Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const factoryAbi = [
  {
    type: "function",
    name: "UNDERLYING_TOKEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "allowableDebtMarketIds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "allowableCollateralMarketIds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "isTokenConverterTrusted",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "executionFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

// multicall with a direct-RPC fallback for chains outside @1delta/providers.
async function read(
  chainId: string,
  calls: { address: string; name: string; args?: any[] }[],
  abi: any,
): Promise<any[]> {
  if (calls.length === 0) return [];
  try {
    return (await multicallRetryUniversal({
      chain: chainId,
      calls: calls.map((c) => ({ ...c, args: c.args ?? [] })) as any,
      abi,
      allowFailure: true,
    })) as any[];
  } catch (e) {
    const rpc = DOLOMITE_FALLBACK_RPCS[chainId];
    if (!rpc) throw e;
    const client = createPublicClient({ transport: http(rpc) });
    return Promise.all(
      calls.map((c) =>
        client
          .readContract({
            address: c.address as `0x${string}`,
            abi,
            functionName: c.name as any,
            args: (c.args ?? []) as any,
          })
          .catch(() => null),
      ),
    );
  }
}

const ok = (v: any) => v !== null && v !== undefined && v !== "0x";

/**
 * Detect the isolation-mode markets on a chain (by the same `name()` rule the
 * protocol uses) and read each factory's underlying, allow-lists, execution
 * fee and the on-chain trust of the vendored wrapper/unwrapper pair.
 */
export async function fetchDolomiteIsolation(
  chainId: string,
  markets: Record<string, string>,
): Promise<DolomiteIsolationChain> {
  const entries = Object.entries(markets);
  const names = await read(
    chainId,
    entries.map(([, token]) => ({ address: token, name: "name" })),
    erc20Abi,
  );
  const iso = entries.filter(([, token], i) => {
    const n = names[i];
    return (
      typeof n === "string" &&
      (n.startsWith(ISOLATION_PREFIX) || n === FS_GLP_NAME)
    );
  });
  if (iso.length === 0) return {};

  const seed = CONVERTER_SEED[chainId] ?? {};
  const facCalls = iso.flatMap(([, f]) => {
    const c = seed[f.toLowerCase()];
    return [
      { address: f, name: "UNDERLYING_TOKEN" },
      { address: f, name: "allowableDebtMarketIds" },
      { address: f, name: "allowableCollateralMarketIds" },
      { address: f, name: "executionFee" },
      // Probe the seed's converters; the zero address stands in when there is
      // no seed so the call layout stays fixed (answers false).
      {
        address: f,
        name: "isTokenConverterTrusted",
        args: [c?.wrapper ?? "0x0000000000000000000000000000000000000000"],
      },
      {
        address: f,
        name: "isTokenConverterTrusted",
        args: [c?.unwrapper ?? "0x0000000000000000000000000000000000000000"],
      },
    ];
  });
  const fac = await read(chainId, facCalls, factoryAbi);

  const underlyings = iso.map((_, i) => fac[i * 6]);
  const undCalls = underlyings.flatMap((u) =>
    ok(u)
      ? [
          { address: u, name: "symbol" },
          { address: u, name: "decimals" },
        ]
      : [],
  );
  const und = await read(chainId, undCalls, erc20Abi);

  const out: DolomiteIsolationChain = {};
  let u = 0;
  iso.forEach(([marketId, factory], i) => {
    const base = i * 6;
    const underlying = fac[base];
    if (!ok(underlying)) {
      console.log(
        `Dolomite: chain ${chainId}: isolation market ${marketId} (${factory}) has no UNDERLYING_TOKEN — skipped`,
      );
      return;
    }
    const symbol = und[u * 2];
    const decimals = und[u * 2 + 1];
    u++;
    const c = seed[factory.toLowerCase()];
    const wrapperTrusted = c ? fac[base + 4] === true : false;
    const unwrapperTrusted = c ? fac[base + 5] === true : false;
    if (c && !(wrapperTrusted && unwrapperTrusted)) {
      console.log(
        `Dolomite: chain ${chainId}: isolation market ${marketId} converters from the seed are NOT trusted on-chain (wrapper ${wrapperTrusted}, unwrapper ${unwrapperTrusted}) — written as null`,
      );
    }
    const fee = fac[base + 3];
    out[marketId] = {
      factory: factory.toLowerCase(),
      underlying: String(underlying).toLowerCase(),
      underlyingSymbol: typeof symbol === "string" ? symbol : "",
      underlyingDecimals: ok(decimals) ? Number(decimals) : 18,
      allowableDebtMarketIds: (ok(fac[base + 1])
        ? (fac[base + 1] as bigint[])
        : []
      ).map(String),
      allowableCollateralMarketIds: (ok(fac[base + 2])
        ? (fac[base + 2] as bigint[])
        : []
      ).map(String),
      wrapper: wrapperTrusted ? c!.wrapper.toLowerCase() : null,
      unwrapper: unwrapperTrusted ? c!.unwrapper.toLowerCase() : null,
      wrapperInputMarketIds: c?.wrapperMarketIds ?? [],
      unwrapperOutputMarketIds: c?.unwrapperMarketIds ?? [],
      async: c?.isAsync ?? false,
      // `executionFee()` only exists on the async (GMX V2 / GLV) factories.
      executionFeeWei: ok(fee) ? String(fee) : null,
    };
  });
  return out;
}
