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
import { getEvmClientUniversal } from "@1delta/providers";
// Per-scan getLogs budget. Override with EVENT_SCAN_MAX_CALLS for chains whose
// RPC caps ranges tightly over a long history (more calls = longer but deeper).
const MAX_LOG_CALLS = Number(process.env.EVENT_SCAN_MAX_CALLS) || 600;
const RETRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Transient = worth retrying the SAME range (rate limit / timeout / socket). */
export function isTransient(err) {
    const m = String(err?.message ?? err).toLowerCase();
    return (m.includes("429") ||
        m.includes("too many request") ||
        m.includes("took too long") ||
        m.includes("timeout") ||
        m.includes("timed out") ||
        m.includes("etimedout") ||
        m.includes("econnreset") ||
        m.includes("socket") ||
        m.includes("fetch failed") ||
        m.includes("network"));
}
/** Retry transient failures with exponential backoff; rethrow otherwise. */
export async function withRetry(fn) {
    let lastErr;
    for (let i = 0; i <= RETRIES; i++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (!isTransient(err) || i === RETRIES)
                throw err;
            await sleep(400 * 2 ** i);
        }
    }
    throw lastErr;
}
/** Lowest block at which `address` has bytecode (its deployment block). */
async function findDeployBlock(client, address) {
    let lo = 0n;
    let hi = await withRetry(() => client.getBlockNumber());
    while (lo < hi) {
        const mid = (lo + hi) / 2n;
        // Retry transient RPC errors so a 429 isn't misread as "no code here"
        // (which would push the deploy block too late and miss early events).
        const code = await withRetry(() => client.getBytecode({ address, blockNumber: mid })).catch(() => "0x");
        if (code && code !== "0x")
            hi = mid;
        else
            lo = mid + 1n;
    }
    return lo;
}
// Candidate block-range spans, largest first. The biggest that the RPC accepts
// (probed at head) becomes the fixed chunk size for the whole scan.
const SPAN_CANDIDATES = [
    5000000n,
    2000000n,
    1000000n,
    500000n,
    200000n,
    100000n,
    50000n,
    10000n,
];
/** Largest candidate span the RPC accepts for a getLogs call (probed at head). */
async function probeSpan(client, address, event, latest, state) {
    for (const span of SPAN_CANDIDATES) {
        const from = latest > span ? latest - span : 0n;
        try {
            state.calls++;
            await withRetry(() => client.getLogs({ address, event, fromBlock: from, toBlock: latest }));
            return span;
        }
        catch {
            // range rejected (or too many results) — try a smaller span
        }
    }
    return SPAN_CANDIDATES[SPAN_CANDIDATES.length - 1];
}
/**
 * Scan [from, to] for `event` logs. Transient errors retry the same range;
 * persistent errors bisect (bounded by the shared call budget). Used per fixed
 * chunk, so bisection rarely triggers.
 */
async function scanChunk(client, address, event, from, to, onLog, state) {
    if (state.calls >= MAX_LOG_CALLS) {
        throw new Error(`getLogs call budget (${MAX_LOG_CALLS}) exceeded`);
    }
    let logs;
    try {
        state.calls++;
        logs = (await withRetry(() => client.getLogs({ address, event, fromBlock: from, toBlock: to })));
    }
    catch (err) {
        if (to <= from)
            throw err; // single block already failing: real error
        const mid = (from + to) / 2n;
        await scanChunk(client, address, event, from, mid, onLog, state);
        await scanChunk(client, address, event, mid + 1n, to, onLog, state);
        return;
    }
    for (const l of logs)
        onLog(l);
}
/**
 * Invoke `onLog` for every `event` log emitted by `address` on `chainId`, from
 * the contract's deploy block to head. Probes the RPC's max block-range once,
 * then walks fixed chunks of that size. Throws if the chain's RPC is
 * unreachable or too restrictive to scan within the call budget — callers
 * should catch per-chain and continue.
 */
export async function scanContractEvents(chainId, address, event, onLog) {
    const client = getEvmClientUniversal({ chain: chainId, rpcId: 0 });
    const latest = await withRetry(() => client.getBlockNumber());
    const deploy = await findDeployBlock(client, address);
    const state = { calls: 0 };
    const span = await probeSpan(client, address, event, latest, state);
    for (let from = deploy; from <= latest; from += span + 1n) {
        const to = from + span > latest ? latest : from + span;
        await scanChunk(client, address, event, from, to, onLog, state);
    }
}
