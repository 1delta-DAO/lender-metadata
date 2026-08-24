import { getEvmClient } from "@1delta/providers";
import {
  BaseError,
  encodeFunctionData,
  HttpRequestError,
  TimeoutError,
} from "viem";

/**
 * Which Compound V2 markets are NATIVE markets (the CEther shape: `mint()`
 * payable, no argument), regardless of what `underlying()` claims.
 *
 * The generator resolves a market's underlying by calling `underlying()` and
 * mapping a revert to the zero address — the convention every consumer reads
 * as "this market takes the chain's native coin". That works for a textbook
 * CEther, which has no `underlying()` at all.
 *
 * It is not enough. Several forks ship a CEther-shaped market that ANSWERS
 * `underlying()` with the wrapped-native (or wrapped-BTC) token:
 *
 *   FILDA/56     fBNB   "Filda BNB"   -> WBNB
 *   FILDA/4689   fIOTX  "Filda IOTX"  -> WIOTX
 *   BASIC/4689   bIOTX  "Basic IOTX"  -> WIOTX
 *   ENZO/200901  eBTC   "Enzo BTC"    -> WBTC
 *
 * Published that way, the calldata builders take the ERC-20 branch: wrap,
 * approve, `mint(uint256)`. And that is worse than a revert, because these are
 * delegator-pattern cTokens whose fallback SILENTLY SUCCEEDS on an unknown
 * selector — measured on a BNB fork, `mint(uint256)` on fBNB consumed 723 gas,
 * emitted no `Mint`, minted nothing, and the whole transaction returned
 * status 1 with the user's wrapped balance stranded on the Composer.
 *
 * So the shape is probed rather than inferred: `mint(uint256)` is simulated,
 * and a call that SUCCEEDS WITH NO RETURN DATA proves the selector does not
 * exist (a real `mint(uint256)` returns a `uint`, and a real failure reverts).
 *
 * Three rules this probe keeps:
 *
 *  1. **Only an empty SUCCESS is evidence.** A revert means the function is
 *     there (or the fallback reverts, which is the safe shape either way).
 *  2. **A transport failure is never an answer** — same rule as `./pause.ts`.
 *     An unreachable market keeps whatever `underlying()` said, because
 *     rewriting a live ERC-20 market to "native" would break every deposit on
 *     it. The override only ever fires on a confident probe.
 *  3. **`mint()` is NOT probed to confirm.** CEther's `mint()` returns void,
 *     so an empty success proves nothing there — the two cases are
 *     indistinguishable. Only the absence of `mint(uint256)` is decidable.
 */

const MINT_UINT = encodeFunctionData({
  abi: [
    {
      inputs: [{ name: "mintAmount", type: "uint256" }],
      name: "mint",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "nonpayable",
      type: "function",
    },
  ] as const,
  functionName: "mint",
  args: [1n],
});

/** A neutral, code-free caller — never the zero address, some forks reject it. */
const PROBE_ACCOUNT = "0x0000000000000000000000000000000000000001";
const RPC_TRIES = 3;

const TRANSPORT_MARKERS = [
  "http request failed",
  "timed out",
  "fetch failed",
  "rate limit",
  "too many requests",
];

/** Revert vs transport — structured first, substring only on `shortMessage`. */
function isTransport(e: unknown): boolean {
  const err = e as BaseError;
  if (
    typeof err?.walk === "function" &&
    err.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError)
  )
    return true;
  const msg = String(err?.shortMessage ?? err?.message ?? e).toLowerCase();
  if (TRANSPORT_MARKERS.some((m) => msg.includes(m))) return true;
  // an unrecognised failure is treated as transport — never as an answer
  return !msg.includes("revert");
}

/**
 * `true`  — `mint(uint256)` is absent, so this is a native market.
 * `false` — it is present (or the fallback reverts): leave the row alone.
 * `undefined` — could not tell; leave the row alone.
 */
async function probeOne(
  chain: string,
  cToken: string,
): Promise<boolean | undefined> {
  let sawRevert = false;
  for (let rpcId = 0; rpcId < RPC_TRIES; rpcId++) {
    try {
      const { data } = await getEvmClient(chain, rpcId).call({
        to: cToken as `0x${string}`,
        data: MINT_UINT,
        account: PROBE_ACCOUNT as `0x${string}`,
      });
      // Success. Empty return = no such function; a real `mint` returns a uint.
      return (data?.length ?? 0) < 3;
    } catch (e) {
      if (!isTransport(e)) {
        sawRevert = true;
        break;
      }
    }
  }
  return sawRevert ? false : undefined;
}

/**
 * Returns the subset of `cTokens` that are native markets despite reporting a
 * non-zero `underlying()`. Probed only for markets the caller could not
 * already classify (i.e. those with a non-zero underlying).
 */
export async function findNativeMarkets(
  chain: string,
  cTokens: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const cToken of cTokens) {
    const isNative = await probeOne(chain, cToken);
    if (isNative) out.add(cToken.toLowerCase());
  }
  return out;
}
