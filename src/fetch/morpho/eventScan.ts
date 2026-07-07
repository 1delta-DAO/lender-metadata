// ============================================================================
// Robust contract-log scanner shared by the on-chain Morpho discovery jobs
// (vaults via a factory's `CreateMetaMorpho`, markets via the core's
// `CreateMarket`).
//
// Strategy: binary-search the contract's deploy block, then request the whole
// post-deploy range in one `getLogs` call and bisect on persistent RPC errors
// (block-range / result-count limits vary widely across chains). Transient
// errors (rate limit / timeout / socket) retry the same range with backoff.
// A per-scan call budget guards against a restrictive RPC bisecting into
// thousands of sequential calls and hanging the job — when exceeded the scan
// throws so the caller can report the chain as failed rather than silently
// returning a truncated result.
// ============================================================================

import type { AbiEvent } from "viem";
import { getEvmClientUniversal } from "@1delta/providers";

// Per-scan getLogs budget. Override with EVENT_SCAN_MAX_CALLS for chains whose
// RPC caps ranges tightly over a long history (more calls = longer but deeper).
// This is a floor: scanContractEvents raises it to comfortably cover the actual
// deploy->head range at the probed chunk size, so a chain with a wide history
// but a modest per-call block cap (e.g. Pharos: 7.5M blocks, 10k/call) still
// completes instead of tripping the guard.
const MAX_LOG_CALLS = Number(process.env.EVENT_SCAN_MAX_CALLS) || 600;
// How many of a chain's configured RPCs to probe for the widest getLogs window.
// The default RPC (rpcId 0) is often the most rate-limited; a fallback frequently
// accepts far larger ranges (Pharos: 500 blocks on rpc.pharos.xyz vs 10k on the
// originstake fallback), turning a 15k-call scan into a ~750-call one.
const MAX_RPCS_TO_PROBE = Number(process.env.EVENT_SCAN_MAX_RPCS) || 4;
// Small delay before each getLogs call. Public RPCs that accept a wide block
// range (e.g. Pharos' originstake fallback) trip their own circuit breaker when
// hammered with hundreds of back-to-back calls; a light pace avoids that while
// adding only a bounded amount to short scans. Override with EVENT_SCAN_PACE_MS.
const PACE_MS = Number(process.env.EVENT_SCAN_PACE_MS) || 100;
const RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient = worth retrying the SAME range (rate limit / timeout / socket). */
export function isTransient(err: unknown): boolean {
  const m = String((err as any)?.message ?? err).toLowerCase();
  return (
    m.includes("429") ||
    m.includes("too many request") ||
    m.includes("took too long") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("etimedout") ||
    m.includes("econnreset") ||
    m.includes("socket") ||
    m.includes("fetch failed") ||
    m.includes("network") ||
    // Overload / gateway signals from load-balanced public RPCs — the range is
    // fine, the upstream is momentarily unavailable, so retry (with backoff)
    // rather than bisecting a healthy range into single blocks.
    m.includes("circuit breaker") ||
    m.includes("failsafe") ||
    m.includes("internal error") ||
    m.includes("upstream") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504")
  );
}

/** Retry transient failures with exponential backoff; rethrow otherwise. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === RETRIES) throw err;
      await sleep(400 * 2 ** i);
    }
  }
  throw lastErr;
}

/** Lowest block at which `address` has bytecode (its deployment block). */
async function findDeployBlock(client: any, address: string): Promise<bigint> {
  let lo = 0n;
  let hi = await withRetry<bigint>(() => client.getBlockNumber());
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    // Retry transient RPC errors so a 429 isn't misread as "no code here"
    // (which would push the deploy block too late and miss early events).
    const code = await withRetry(() =>
      client.getBytecode({ address, blockNumber: mid }),
    ).catch(() => "0x");
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

// Candidate block-range spans, largest first. The biggest that the RPC accepts
// (probed at head) becomes the fixed chunk size for the whole scan.
const SPAN_CANDIDATES = [
  5_000_000n,
  2_000_000n,
  1_000_000n,
  500_000n,
  200_000n,
  100_000n,
  50_000n,
  10_000n,
];

/** Largest candidate span `client` accepts for a getLogs call (probed at head). */
async function probeSpan(
  client: any,
  address: string,
  event: AbiEvent,
  latest: bigint,
  state: { calls: number },
): Promise<bigint | null> {
  for (const span of SPAN_CANDIDATES) {
    const from = latest > span ? latest - span : 0n;
    try {
      state.calls++;
      await withRetry(() =>
        client.getLogs({ address, event, fromBlock: from, toBlock: latest }),
      );
      return span;
    } catch {
      // range rejected (or too many results) — try a smaller span
    }
  }
  // Even the smallest candidate was rejected: this RPC is unusable for the scan.
  return null;
}

/**
 * Probe up to MAX_RPCS_TO_PROBE of the chain's configured RPCs and return the
 * client that accepts the widest getLogs window, plus that span. Different RPCs
 * for the same chain can differ by 20x in their per-call block-range cap, and
 * the default (rpcId 0) is frequently the most restrictive.
 *
 * Throws if none of the probed RPCs can serve even the smallest candidate span.
 */
async function pickWidestRpc(
  chainId: string,
  address: string,
  event: AbiEvent,
  state: { calls: number },
): Promise<{ client: any; latest: bigint; span: bigint }> {
  let best: { client: any; latest: bigint; span: bigint } | null = null;
  let lastErr: unknown;
  for (let rpcId = 0; rpcId < MAX_RPCS_TO_PROBE; rpcId++) {
    let client: any;
    let latest: bigint;
    try {
      client = getEvmClientUniversal({ chain: chainId, rpcId });
      latest = await withRetry<bigint>(() => client.getBlockNumber());
    } catch (err) {
      lastErr = err;
      continue; // RPC unreachable — try the next one
    }
    const span = await probeSpan(client, address, event, latest, state);
    if (span != null && (!best || span > best.span)) {
      best = { client, latest, span };
      // A wide span (>= 100k) is plenty; stop probing to save calls.
      if (span >= 100_000n) break;
    }
  }
  if (!best) {
    throw new Error(
      `no usable RPC for chain ${chainId} (none served a getLogs range)` +
        (lastErr ? `: ${String((lastErr as any)?.message ?? lastErr)}` : ""),
    );
  }
  return best;
}

/**
 * Scan [from, to] for `event` logs. Transient errors retry the same range;
 * persistent errors bisect (bounded by the shared call budget). Used per fixed
 * chunk, so bisection rarely triggers.
 */
async function scanChunk(
  client: any,
  address: string,
  event: AbiEvent,
  from: bigint,
  to: bigint,
  onLog: (log: any) => void,
  state: { calls: number; budget: number },
): Promise<void> {
  if (state.calls >= state.budget) {
    throw new Error(`getLogs call budget (${state.budget}) exceeded`);
  }
  let logs: any[];
  try {
    state.calls++;
    if (PACE_MS > 0) await sleep(PACE_MS);
    logs = (await withRetry(() =>
      client.getLogs({ address, event, fromBlock: from, toBlock: to }),
    )) as any[];
  } catch (err) {
    if (to <= from) throw err; // single block already failing: real error
    const mid = (from + to) / 2n;
    await scanChunk(client, address, event, from, mid, onLog, state);
    await scanChunk(client, address, event, mid + 1n, to, onLog, state);
    return;
  }
  for (const l of logs) onLog(l);
}

/**
 * Invoke `onLog` for every `event` log emitted by `address` on `chainId`, from
 * the contract's deploy block to head. Probes the RPC's max block-range once,
 * then walks fixed chunks of that size. Throws if the chain's RPC is
 * unreachable or too restrictive to scan within the call budget — callers
 * should catch per-chain and continue.
 */
export async function scanContractEvents(
  chainId: string,
  address: string,
  event: AbiEvent,
  onLog: (log: any) => void,
): Promise<void> {
  const state = { calls: 0, budget: MAX_LOG_CALLS };
  const { client, latest, span } = await pickWidestRpc(
    chainId,
    address,
    event,
    state,
  );
  const deploy = await findDeployBlock(client, address);

  // Raise the call budget so a wide history at a modest chunk size still
  // completes: chunks are fixed-size and only bisect on error, so the call
  // count is ~range/span; give it 3x headroom for retries/bisection.
  const chunksNeeded = Number((latest - deploy) / (span + 1n)) + 1;
  state.budget = Math.max(MAX_LOG_CALLS, Math.ceil(chunksNeeded * 3));

  for (let from = deploy; from <= latest; from += span + 1n) {
    const to = from + span > latest ? latest : from + span;
    await scanChunk(client, address, event, from, to, onLog, state);
  }
}
