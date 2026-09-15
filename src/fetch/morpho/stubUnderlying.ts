// ============================================================================
// Stub-underlying guard shared by every job that appends to
// data/morpho-type-vaults.json.
//
// The MetaMorpho / Vaults V2 factory deployment script deploys a 129-byte
// `DummyERC20` (approve() + decimals() only — name / symbol / totalSupply /
// balanceOf / transfer all revert) and one nameless, empty vault over it in
// the same tx, on every chain. Discovered from the factory's create events or
// from a thin indexer (Feather), that vault is indistinguishable from a real
// one — it has an `asset()` and a version — so it was appended to the
// catalogue on 17 chains and its underlying offered to the token-list pipeline
// as a "missing token" (see MORPHO_STUB_VAULTS.md).
//
// Every append job runs its candidates through `dropStubUnderlyings` first.
// The classifier is the audit's (`src/audit-vault-underlyings.ts` imports it
// from here so the two cannot drift): an underlying is a stub when
// `totalSupply()` reverts, or `name()` AND `symbol()` both revert / answer
// empty. Bytecode size is NOT a criterion — USDS, RLUSD, wM, EURe … sit behind
// 45–300 B proxies and Tempo's pathUSD precompile has 1 byte of code.
//
// The guard FAILS OPEN. A chain whose RPC is unreachable, or whose multicall
// aggregator answers `0x` for everything (Citrea, Tempo) and cannot be read
// call-by-call either, is left unfiltered with a warning: dropping a real
// vault on an RPC hiccup is worse than re-adding a stub, which the audit
// catches on its next run.
// ============================================================================

import { parseAbi, type Hex } from "viem";
import { getEvmClientUniversal, multicallRetryUniversal } from "@1delta/providers";

export const ERC20_PROBE_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

/** Byte length of the factory smoke-test `DummyERC20` (approve()+decimals() only). */
export const DUMMY_ERC20_BYTES = 129;

export interface TokenProbe {
  /** `null` when not probed (the guard never reads code; the audit does). */
  codeBytes: number | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
}

export type ProbeVerdict = "no-code" | "stub" | "suspicious" | "ok";

export type ProbeCall = { address: string; name: string; args: unknown[] };

// multicallRetryUniversal(allowFailure) hands back the raw `0x` for a call that
// reverted / returned nothing — never a valid string/uint here, so it is "failed".
export const unwrapProbe = (r: unknown): unknown => {
  const v =
    r && typeof r === "object" && "status" in (r as any)
      ? (r as any).status === "success"
        ? (r as any).result
        : undefined
      : r && typeof r === "object" && "result" in (r as any)
        ? (r as any).result
        : r;
  return v === "0x" ? undefined : v;
};

const asString = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const asNumber = (v: unknown): number | null =>
  typeof v === "bigint" || typeof v === "number" ? Number(v) : null;
const asBig = (v: unknown): string | null =>
  typeof v === "bigint" || typeof v === "number" ? String(v) : null;

const clientFor = (chainId: string, rpcId: number) => {
  try {
    return getEvmClientUniversal({ chain: chainId, rpcId, timeoutMs: 20_000 });
  } catch {
    return null;
  }
};

const isRevert = (e: any) =>
  /reverted|returned no data/i.test(String(e?.shortMessage ?? e));

/** Direct eth_call per entry — the fallback when the chain has no working
 *  multicall aggregator. Rotates RPCs on transport errors; a revert is `0x`.
 *  `null` when no RPC answered anything at all (transport dead). */
export async function directProbeCalls(
  chainId: string,
  calls: ProbeCall[],
  abi: unknown,
): Promise<unknown[] | null> {
  const clients = [0, 1, 2, 3].map((id) => clientFor(chainId, id)).filter(Boolean);
  if (clients.length === 0) return null;
  const out: unknown[] = new Array(calls.length).fill("0x");
  let anyTransportOk = false;
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async () => {
    while (next < calls.length) {
      const i = next++;
      const c = calls[i];
      for (const client of clients) {
        try {
          out[i] = await client!.readContract({
            address: c.address as Hex,
            abi: abi as any,
            functionName: c.name,
            args: c.args as any,
          });
          anyTransportOk = true;
          break;
        } catch (e: any) {
          if (isRevert(e)) {
            anyTransportOk = true;
            break;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return anyTransportOk ? out : null;
}

/** Batched read with the direct-call fallback. `null` = chain unreachable. */
export async function probeMulticall(
  chainId: string,
  calls: ProbeCall[],
  abi: unknown,
): Promise<unknown[] | null> {
  if (calls.length === 0) return [];
  let res: unknown[] | null = null;
  try {
    res = (await multicallRetryUniversal({
      chain: chainId,
      calls,
      abi,
      allowFailure: true,
      logErrors: false,
    })) as unknown[];
  } catch {
    res = null;
  }
  // Every call failing means the aggregator is the problem (no Multicall3,
  // or one that swallows results), not the tokens — read them one by one.
  if (!res || res.every((r) => unwrapProbe(r) === undefined)) {
    const direct = await directProbeCalls(chainId, calls, abi);
    if (direct) return direct;
  }
  return res;
}

/** name / symbol / decimals / totalSupply for each address, index-aligned.
 *  `null` when the chain could not be read at all. */
export async function probeErc20s(
  chainId: string,
  addresses: string[],
): Promise<TokenProbe[] | null> {
  const FIELDS = ["name", "symbol", "decimals", "totalSupply"] as const;
  const meta = await probeMulticall(
    chainId,
    addresses.flatMap((address) =>
      FIELDS.map((name) => ({ address, name, args: [] })),
    ),
    ERC20_PROBE_ABI,
  );
  if (meta === null) return null;
  return addresses.map((_, i) => ({
    codeBytes: null,
    name: asString(unwrapProbe(meta[i * 4])),
    symbol: asString(unwrapProbe(meta[i * 4 + 1])),
    decimals: asNumber(unwrapProbe(meta[i * 4 + 2])),
    totalSupply: asBig(unwrapProbe(meta[i * 4 + 3])),
  }));
}

export function classifyTokenProbe(t: TokenProbe): {
  verdict: ProbeVerdict;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (t.codeBytes === 0) return { verdict: "no-code", reasons: ["no bytecode at address"] };
  const nameEmpty = !t.name;
  const symbolEmpty = !t.symbol;
  if (nameEmpty && symbolEmpty) reasons.push("name() and symbol() both revert/empty");
  if (t.totalSupply == null) reasons.push("totalSupply() reverts");
  if (reasons.length) {
    if (t.codeBytes === DUMMY_ERC20_BYTES && t.decimals === 0)
      reasons.unshift("DummyERC20 fingerprint (129B, decimals()=0, approve-only)");
    else if (t.codeBytes != null) reasons.push(`bytecode ${t.codeBytes}B`);
    return { verdict: "stub", reasons };
  }
  if (nameEmpty) reasons.push("name() reverts/empty");
  if (symbolEmpty) reasons.push("symbol() reverts/empty");
  if (t.decimals == null) reasons.push("decimals() reverts");
  if (reasons.length) return { verdict: "suspicious", reasons };
  return { verdict: "ok", reasons };
}

/**
 * Split `items` into the ones whose `underlying` is a real ERC20 and the ones
 * whose underlying probes as a stub. Probes each unique underlying once.
 *
 * Fails open: if the chain cannot be read, or EVERY one of two or more distinct
 * underlyings probes as a stub — which is an RPC answering nothing, not a
 * catalogue of dummies — nothing is dropped and a warning names the chain. A
 * chain whose ONLY underlying is the smoke-test (Linea at purge time) is still
 * filtered: one address reading as a stub over a transport that provably
 * answered (a revert is an answer) is the finding itself, not a hiccup.
 */
export async function dropStubUnderlyings<T extends { underlying: string }>(
  chainId: string,
  items: T[],
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<{ kept: T[]; dropped: T[] }> {
  if (items.length === 0) return { kept: [], dropped: [] };
  const addrs = [...new Set(items.map((i) => i.underlying.toLowerCase()))];
  const probes = await probeErc20s(chainId, addrs);
  if (probes === null) {
    log(
      `  chain ${chainId}: stub-underlying probe unreachable — keeping all ${items.length} vaults unfiltered`,
    );
    return { kept: items, dropped: [] };
  }
  const stub = new Set<string>();
  addrs.forEach((a, i) => {
    if (classifyTokenProbe(probes[i]).verdict === "stub") stub.add(a);
  });
  if (addrs.length > 1 && stub.size === addrs.length) {
    log(
      `  chain ${chainId}: every one of ${addrs.length} underlyings probed as a stub — RPC answered nothing; keeping all vaults unfiltered`,
    );
    return { kept: items, dropped: [] };
  }
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const it of items)
    (stub.has(it.underlying.toLowerCase()) ? dropped : kept).push(it);
  if (dropped.length)
    log(
      `  chain ${chainId}: dropped ${dropped.length} vault(s) over a stub underlying: ${dropped
        .map((d) => `${(d as any).vault ?? (d as any).address ?? "?"}→${d.underlying}`)
        .join(", ")}`,
    );
  return { kept, dropped };
}
