import { getEvmClient, getEvmClientWithCustomRpcs } from "@1delta/providers";
import { sleep } from "../../utils.js";
import { encodeFunctionData, HttpRequestError, TimeoutError, zeroAddress, } from "viem";
/**
 * Per-market pause state for Compound V2 forks whose Comptroller exposes no
 * `mintGuardianPaused(address)` / `borrowGuardianPaused(address)` getter.
 *
 * The fetcher reads those two getters live for every fork that has them, so
 * this file only fills the hole underneath: WePiggy's Comptroller carries
 * `_setMintPaused` and `pauseGuardian()` but keeps the mappings private, and it
 * does have paused markets. Nothing on that deployment can read the flag —
 * except the Comptroller's own hook.
 *
 * So we simulate the hook the cToken itself calls and decode the answer:
 *
 *   mintAllowed(cToken, account, 0)   → returns 0        ⇒ not paused
 *                                     → "mint is paused" ⇒ paused
 *   borrowAllowed(cToken, account, 0) → "borrow is paused" ⇒ paused
 *                                     → any other revert   ⇒ not paused
 *
 * The "any other revert" branch matters: an unpaused `borrowAllowed` reverts
 * `"sender must be cToken"`, because the pause check runs BEFORE the caller
 * check.
 *
 * **A TRANSPORT failure is never an answer.** Both a missing getter and a
 * rate-limited RPC arrive as "the call did not return", and collapsing them
 * publishes `false` — i.e. "open" — for a paused market, which is the exact
 * bug this whole mechanism exists to fix. Every call is therefore classified
 * revert-vs-transport, retried across RPCs, and an unresolved leg is simply
 * omitted (absent = unknown to the consumer).
 *
 * Emitted onto the cToken array entries as `mintPaused` / `borrowPaused`, and
 * ONLY for forks that cannot be read live — the fetcher prefers its own read
 * wherever one exists, so publishing both would just add a stale copy.
 */
const PAUSE_ABI = [
    {
        inputs: [{ internalType: "address", name: "", type: "address" }],
        name: "mintGuardianPaused",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "cToken", type: "address" },
            { internalType: "address", name: "minter", type: "address" },
            { internalType: "uint256", name: "mintAmount", type: "uint256" },
        ],
        name: "mintAllowed",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "cToken", type: "address" },
            { internalType: "address", name: "borrower", type: "address" },
            { internalType: "uint256", name: "borrowAmount", type: "uint256" },
        ],
        name: "borrowAllowed",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "nonpayable",
        type: "function",
    },
];
/** A neutral, code-free caller — never the zero address, some forks reject it. */
const PROBE_ACCOUNT = "0x0000000000000000000000000000000000000001";
/** How many RPCs to rotate through before giving up on a single call. */
const RPC_TRIES = 4;
/** Prefer a decoded reason, then a bare revert, then nothing. */
const RANK = {
    ok: 3,
    revert: 3,
    empty: 2,
    unreachable: 1,
};
const TRANSPORT_MARKERS = [
    "http request failed",
    "timed out",
    "fetch failed",
    "rate limit",
    "too many requests",
];
/**
 * Revert vs transport.
 *
 * Structured first (viem's error chain), and only then a substring check —
 * against `shortMessage`, NEVER the full `message`. The full message embeds
 * the raw call arguments, so a marker like "503" matches inside a hex address
 * (`0x27a948…a8503fda…`) and reports a perfectly good revert as a dead RPC.
 * That is not hypothetical: it silently emptied WePiggy's whole probe.
 */
function classify(e) {
    const err = e;
    if (typeof err?.walk === "function" &&
        err.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError))
        return { kind: "unreachable" };
    const msg = String(err?.shortMessage ?? err?.message ?? e).toLowerCase();
    if (TRANSPORT_MARKERS.some((m) => msg.includes(m)))
        return { kind: "unreachable" };
    if (msg.includes("revert"))
        return { kind: "revert", reason: msg };
    // an unrecognised failure is treated as unreachable — never as an answer
    return { kind: "unreachable" };
}
/**
 * `rpcs` overrides the endpoint list for one chain — the generator leaves it
 * unset, tests pass a known-good endpoint (the default chain-1 list is
 * rate-limited often enough to make this the difference between a real answer
 * and a shrug).
 */
async function rawCall(chain, to, data, rpcs) {
    let best = { kind: "unreachable" };
    for (let rpcId = 0; rpcId < RPC_TRIES; rpcId++) {
        let res;
        try {
            const client = rpcs?.length
                ? getEvmClientWithCustomRpcs(chain, rpcId, { [chain]: rpcs })
                : getEvmClient(chain, rpcId);
            const { data: ret } = await client.call({
                to: to,
                data,
            });
            // 2 chars of '0x' + one 32-byte word; anything shorter is a swallowed
            // revert, not an answer
            res = (ret?.length ?? 0) >= 66 ? { kind: "ok" } : { kind: "empty" };
        }
        catch (e) {
            res = classify(e);
        }
        if (RANK[res.kind] > RANK[best.kind])
            best = res;
        // a decoded reason (or real data) is final; keep rotating otherwise, in
        // case another endpoint reports the reason this one dropped
        if (res.kind === "ok" || res.kind === "revert")
            return res;
    }
    return best;
}
/**
 * Tri-state: does this Comptroller answer the guardian getters?
 * `undefined` = could not tell, in which case we publish nothing.
 */
async function hasGuardianGetters(chain, comptroller, sampleCToken, rpcs) {
    const res = await rawCall(chain, comptroller, encodeFunctionData({
        abi: PAUSE_ABI,
        functionName: "mintGuardianPaused",
        args: [sampleCToken],
    }), rpcs);
    if (res.kind === "ok")
        return true;
    // a revert — decoded or swallowed to `0x` — means there is no such getter
    if (res.kind === "revert" || res.kind === "empty")
        return false;
    return undefined;
}
async function probeOne(chain, comptroller, cToken, rpcs) {
    const leg = async (functionName, needle) => {
        const res = await rawCall(chain, comptroller, encodeFunctionData({
            abi: PAUSE_ABI,
            functionName,
            args: [cToken, PROBE_ACCOUNT, 0n],
        }), rpcs);
        if (res.kind === "ok")
            return false;
        if (res.kind === "revert")
            return res.reason.includes(needle);
        // `empty` = it reverted but no endpoint gave us the reason, so we cannot
        // tell "paused" from "market not listed"; `unreachable` = no answer at all
        return undefined;
    };
    const [mintPaused, borrowPaused] = await Promise.all([
        leg("mintAllowed", "mint is paused"),
        leg("borrowAllowed", "borrow is paused"),
    ]);
    const out = {};
    if (mintPaused !== undefined)
        out.mintPaused = mintPaused;
    if (borrowPaused !== undefined)
        out.borrowPaused = borrowPaused;
    return out;
}
/**
 * Resolve pause flags for one fork/chain, or `undefined` when the Comptroller
 * exposes the guardian getters (the fetcher reads those live) or when the
 * chain could not be reached at all.
 */
export async function fetchPauseFallback(chain, comptroller, cTokens, rpcs) {
    if (cTokens.length === 0)
        return undefined;
    if (!comptroller || comptroller === zeroAddress)
        return undefined;
    const readable = await hasGuardianGetters(chain, comptroller, cTokens[0], rpcs);
    // `true` → live-readable, nothing to publish.
    if (readable === true)
        return undefined;
    // `undefined` → the chain did not answer at all. Publish nothing rather than
    // a guess, but say so: silence here looks identical to "has getters".
    if (readable === undefined) {
        console.warn(`  pause probe: ${comptroller} on chain ${chain} unreachable — no pause data published`);
        return undefined;
    }
    const out = {};
    for (const cToken of cTokens) {
        // sequential + spaced: this branch only runs for a fork with no getters,
        // and burning a public endpoint's budget here would cost the rest of the
        // dataset run its answers
        const flags = await probeOne(chain, comptroller, cToken, rpcs);
        await sleep(100);
        if (flags.mintPaused !== undefined || flags.borrowPaused !== undefined)
            out[cToken.toLowerCase()] = flags;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
