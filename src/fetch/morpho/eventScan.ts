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

const MAX_LOG_CALLS = 600;
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
    m.includes("network")
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

async function scanRange(
  client: any,
  address: string,
  event: AbiEvent,
  from: bigint,
  to: bigint,
  onLog: (log: any) => void,
  state: { calls: number },
): Promise<void> {
  if (state.calls >= MAX_LOG_CALLS) {
    throw new Error(`getLogs call budget (${MAX_LOG_CALLS}) exceeded`);
  }
  let logs: any[];
  try {
    state.calls++;
    logs = (await withRetry(() =>
      client.getLogs({ address, event, fromBlock: from, toBlock: to }),
    )) as any[];
  } catch (err) {
    if (to <= from) throw err; // single block already failing: real error
    const mid = (from + to) / 2n;
    await scanRange(client, address, event, from, mid, onLog, state);
    await scanRange(client, address, event, mid + 1n, to, onLog, state);
    return;
  }
  for (const l of logs) onLog(l);
}

/**
 * Invoke `onLog` for every `event` log emitted by `address` on `chainId`, from
 * the contract's deploy block to head. Throws if the chain's RPC is unreachable
 * or too restrictive to scan within the call budget — callers should catch
 * per-chain and continue.
 */
export async function scanContractEvents(
  chainId: string,
  address: string,
  event: AbiEvent,
  onLog: (log: any) => void,
): Promise<void> {
  const client = getEvmClientUniversal({ chain: chainId, rpcId: 0 });
  const latest = await withRetry<bigint>(() => client.getBlockNumber());
  const deploy = await findDeployBlock(client, address);
  await scanRange(client, address, event, deploy, latest, onLog, { calls: 0 });
}
