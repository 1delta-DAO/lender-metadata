// ============================================================================
// E-mode category COUNT per Aave-V3-style deployment.
//
// The pool exposes no count getter — only `getEModeCategoryData(uint8 id)` and
// friends — so a consumer cannot learn how many categories exist in the same
// multicall round it reads them in. margin-fetcher used to carry a hardcoded
// per-(fork, chain) table for this, which meant every new category needed an
// npm release, and which was silently WRONG on two deployments (Aave Horizon
// had category 10 while the table stopped at 9; Plasma had 26 while the table
// stopped at 25 — reads past the last category return an empty struct that the
// parser filters out, so an under-count drops a live e-mode with no error).
//
// So we probe it here, daily, and publish the number as `eModeCount` on the
// deployment's `config/aave-pools.json` row. Consumers then query ids
// `0..eModeCount`.
//
// FAIL OPEN: a deployment whose probe did not come back CLEAN is omitted from
// the result, and `mergeData` keeps whatever the file already had. Never write
// a count derived from a partial answer — a lower number silently deletes
// e-modes from production and nothing downstream errors.
// ============================================================================
import { isAaveV2Type, Lender } from "@1delta/lender-registry";
import { multicallRetryUniversal } from "@1delta/providers";
import { sleep } from "../../utils.js";
/**
 * `getEModeCategoryData` returns `EModeCategoryLegacy` on BOTH generations —
 * v3.0/v3.1 and v3.2+ keep the same 5-field shape — so one ABI covers the whole
 * fork book.
 */
const E_MODE_ABI = [
    {
        inputs: [{ internalType: "uint8", name: "id", type: "uint8" }],
        name: "getEModeCategoryData",
        outputs: [
            {
                components: [
                    { internalType: "uint16", name: "ltv", type: "uint16" },
                    {
                        internalType: "uint16",
                        name: "liquidationThreshold",
                        type: "uint16",
                    },
                    { internalType: "uint16", name: "liquidationBonus", type: "uint16" },
                    { internalType: "address", name: "priceSource", type: "address" },
                    { internalType: "string", name: "label", type: "string" },
                ],
                internalType: "struct DataTypes.EModeCategoryLegacy",
                name: "",
                type: "tuple",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
];
/** Category ids are `uint8`. */
const MAX_E_MODE_ID = 255;
/**
 * Ids probed per round. Sized to settle every known deployment in ONE round
 * except Ethereum Aave V3 (48 categories), which takes two.
 */
const WINDOW = 48;
/**
 * Re-probe another window whenever the highest active id lands within this many
 * ids of the end of the one we just scanned. Scanning a whole window rather
 * than stopping at the first inactive id is deliberate: contiguity is an
 * observation, not a guarantee, and a gap would make an early stop under-count.
 */
const HEADROOM = 16;
/**
 * Passes over one window, each starting at a different RPC. The multicall
 * helper rotates providers by itself only when EVERY call in a batch fails —
 * a PARTIAL failure comes back as `'0x'` per call and never rotates, which is
 * exactly what a flaky endpoint produces. Sei is the live example: of its five
 * RPCs two answer, two error and one 403s, and a single pass left four forks
 * unprobed indefinitely. Each pass re-issues only the calls still outstanding.
 */
const ATTEMPTS = 4;
/** Backoff between passes over the same window. */
const RETRY_DELAY_MS = 500;
// Optional comma-separated chain-id allowlist, shared with the other Aave
// fetchers (see fetchReserves.ts).
const AAVE_CHAIN_FILTER = new Set((process.env.AAVE_CHAIN_FILTER ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean));
/**
 * Chains we no longer serve. Their deployments are still in the pool config but
 * nothing fetches them, so probing only produces failures and a warning per
 * deployment on every daily run.
 *
 * Not derived from `getEvmChain` on purpose: this package installs
 * `@1delta/providers` from npm, and the published build still maps Corn even
 * though the source has dropped it — the same staleness that let an
 * `isAaveV3Type` allowlist hide DTRINITY. An explicit list cannot go stale in
 * the direction that matters.
 */
const DEPRECATED_CHAINS = new Set([
    "21000000", // Corn
]);
/** Forks that are Aave-V3-shaped but carry no e-mode surface at all. */
const NO_E_MODES = new Set([Lender.YLDR]);
/**
 * Which forks to probe is decided by EXCLUSION — everything that is not
 * Aave-V2-shaped — rather than by an `isAaveV3Type` allowlist. This package
 * installs `@1delta/lender-registry` from npm, so an allowlist is only as
 * current as that dependency: DTRINITY was added to `AAVE_V3_LENDERS` after
 * 0.0.39 and an allowlist skipped it in silence, which is the failure this
 * whole field exists to stop. A V2 fork that slips through instead reverts on
 * the first pass and is dropped by `unsupported` below — the safe direction.
 */
/**
 * A category counts as present if ANY of its fields is set. The consuming
 * parsers disagree on the test — the legacy path wants `ltv != 0`, the v3.2
 * path wants a non-empty label — so take the union and never fetch fewer ids
 * than either of them would have used.
 */
function isActive(result) {
    if (!result || typeof result !== "object")
        return false;
    return (Number(result.ltv ?? 0) !== 0 ||
        Number(result.liquidationThreshold ?? 0) !== 0 ||
        Number(result.liquidationBonus ?? 0) !== 0 ||
        (result.label ?? "") !== "");
}
/** A failed call comes back as the string `'0x'` (see multicallRetryUniversal). */
function isFailure(result) {
    return !result || typeof result !== "object";
}
/**
 * Probe the highest active e-mode category id for every Aave-V3-style
 * deployment in `AAVE_FORK_POOL_DATA`.
 */
export async function fetchAaveEModeCounts(AAVE_FORK_POOL_DATA) {
    const counts = {};
    // Group deployments by chain so one multicall covers every fork on it.
    const chainToForks = {};
    for (const fork of Object.keys(AAVE_FORK_POOL_DATA)) {
        if (isAaveV2Type(fork) || NO_E_MODES.has(fork))
            continue;
        for (const chain of Object.keys(AAVE_FORK_POOL_DATA[fork] ?? {})) {
            if (AAVE_CHAIN_FILTER.size && !AAVE_CHAIN_FILTER.has(chain))
                continue;
            const pool = AAVE_FORK_POOL_DATA[fork][chain]?.pool;
            if (!pool)
                continue;
            if (!chainToForks[chain])
                chainToForks[chain] = [];
            chainToForks[chain].push({ fork, pool });
        }
    }
    for (const chain of Object.keys(chainToForks)) {
        if (DEPRECATED_CHAINS.has(chain)) {
            console.log(`  e-modes: chain ${chain} is deprecated — skipped`);
            continue;
        }
        // `pending` shrinks as deployments settle; only the ones still near the end
        // of the scanned window are carried into the next round.
        let pending = chainToForks[chain].map(({ fork, pool }) => ({
            fork,
            pool,
            highest: 0,
            clean: true,
            unsupported: false,
        }));
        const settled = [];
        let from = 1;
        while (pending.length && from <= MAX_E_MODE_ID) {
            const to = Math.min(from + WINDOW - 1, MAX_E_MODE_ID);
            const ids = Array.from({ length: to - from + 1 }, (_, i) => from + i);
            // `resolved[probeIndex][idIndex]` — undefined until that exact call has
            // come back from SOME endpoint.
            const resolved = pending.map(() => new Array(ids.length).fill(undefined));
            let outstanding = pending.flatMap((_, probeIndex) => ids.map((_id, idIndex) => ({ probeIndex, idIndex })));
            for (let attempt = 0; attempt < ATTEMPTS && outstanding.length; attempt++) {
                const calls = outstanding.map(({ probeIndex, idIndex }) => ({
                    address: pending[probeIndex].pool,
                    name: "getEModeCategoryData",
                    args: [ids[idIndex]],
                }));
                let results;
                try {
                    results = await multicallRetryUniversal({
                        chain,
                        calls,
                        abi: calls.map(() => E_MODE_ABI),
                        allowFailure: true,
                        // Start each pass on a different endpoint. The helper's own
                        // rotation only kicks in on a total failure, so this is what
                        // actually moves a partial failure off a bad RPC.
                        providerId: attempt,
                    });
                }
                catch (e) {
                    console.warn(`  e-modes: chain ${chain} ids ${from}-${to} pass ${attempt + 1}/${ATTEMPTS} failed:`, e instanceof Error ? e.message : e);
                    await sleep(RETRY_DELAY_MS);
                    continue;
                }
                let stillOutstanding = [];
                outstanding.forEach((slot, i) => {
                    if (isFailure(results[i]))
                        stillOutstanding.push(slot);
                    else
                        resolved[slot.probeIndex][slot.idIndex] = results[i];
                });
                // A pool that answered NOTHING while a sibling on the same chain
                // answered fine does not have the function — an Aave-V2-shaped fork the
                // exclusion filter let through. Drop it now instead of burning every
                // remaining pass on it. The "while a sibling answered" half is what
                // keeps a chain-wide RPC outage (where nothing answers) in the retry
                // path, which is the case the passes exist for.
                const anySuccess = results.some((r) => !isFailure(r));
                if (anySuccess) {
                    const dead = new Set(pending
                        .map((_, i) => i)
                        .filter((i) => resolved[i].every((r) => r === undefined)));
                    if (dead.size) {
                        dead.forEach((i) => {
                            pending[i].unsupported = true;
                        });
                        stillOutstanding = stillOutstanding.filter((slot) => !dead.has(slot.probeIndex));
                    }
                }
                if (stillOutstanding.length && stillOutstanding.length < outstanding.length) {
                    console.log(`  e-modes: chain ${chain} ids ${from}-${to} pass ${attempt + 1}/${ATTEMPTS} left ${stillOutstanding.length} call(s) outstanding`);
                }
                outstanding = stillOutstanding;
                if (outstanding.length)
                    await sleep(RETRY_DELAY_MS);
            }
            const next = [];
            pending.forEach((probe, forkIndex) => {
                const slice = resolved[forkIndex];
                if (slice.some((r) => r === undefined))
                    probe.clean = false;
                slice.forEach((result, i) => {
                    if (isActive(result))
                        probe.highest = Math.max(probe.highest, ids[i]);
                });
                // Still active close to the window edge → there may be more above it.
                if (probe.clean && probe.highest > to - HEADROOM && to < MAX_E_MODE_ID) {
                    next.push(probe);
                }
                else {
                    settled.push(probe);
                }
            });
            pending = next;
            from = to + 1;
            if (pending.length)
                await sleep(250);
        }
        for (const probe of settled) {
            if (probe.unsupported) {
                // No e-mode surface — nothing to publish, and nothing wrong either.
                continue;
            }
            if (!probe.clean) {
                console.warn(`  e-modes: ${probe.fork} on chain ${chain} had failed reads — keeping the existing count`);
                continue;
            }
            if (!counts[probe.fork])
                counts[probe.fork] = {};
            counts[probe.fork][chain] = { eModeCount: probe.highest };
        }
        console.log(`  e-modes chain ${chain}: ${settled
            .filter((p) => p.clean)
            .map((p) => `${p.fork}=${p.highest}`)
            .join(", ")}`);
        await sleep(250);
    }
    return counts;
}
