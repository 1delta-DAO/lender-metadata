// ============================================================================
// Build display labels for Curvance markets.
//
// Curvance is the one integrated lender with NO file in this repo: its roster
// is a built-in seed (`CURVANCE_MONAD_CONFIG` in @1delta/data-sdk), because the
// protocol publishes no market list and Monad's 100-block `eth_getLogs` cap
// makes the registry events unscannable. So there is no `data/curvance-*.json`
// to read labels off — this module DISCOVERS the markets on-chain, the same two
// multicall rounds the margin-fetcher uses:
//
//   CentralRegistry.marketManagers() -> MarketManager.queryTokensListed()
//
// It is deliberately SELF-CONTAINED (inline ABIs, inline addresses, raw viem).
// The published @1delta/abis and @1delta/data-sdk this repo depends on do not
// carry Curvance yet, so importing them would make the generator unrunnable
// until a publish lands — the same blocker the irm repo hit. Once those publish,
// the inline ABI fragments below can be swapped for the real exports; nothing
// else changes.
//
// LABEL SHAPE — note the deliberate divergence from LlamaLend/TermMax/Teller,
// which all order `<debt> / <collateral>`:
//
//   names[CURVANCE_143_<MM>]      = "Curvance WMON / USDC"
//   shortNames[CURVANCE_143_<MM>] = "WMON/USDC"
//
// i.e. COLLATERAL FIRST, matching Curvance's own app naming (`savUSD | USDC`,
// `PT-AUSD | AUSD`). Two reasons, and please do not "fix" this to match the
// other lenders:
//
//  1. The `<debt> / <collateral>` convention assumes exactly one borrowable
//     leg. FIVE of the 25 Curvance markets have BOTH legs borrowable, so there
//     is no unique debt side to put first.
//  2. A label's job is to let a user match a position to what they see in the
//     protocol's own UI. Matching Curvance beats matching our other lenders.
//
// Ordering within a market is `queryTokensListed`'s ARRAY ORDER, verified
// 2026-08-07 to be the canonical one on all 25 live markets:
//
//  - on the 20 markets with a single borrowable leg, the collateral-only leg is
//    first in 20/20, so array order and "collateral first" agree; and
//  - on the 5 markets where BOTH legs are borrowable and "collateral first" has
//    nothing to say (WMON|AUSD, WMON|USDC, WBTC|USDC, WETH|USDC, eBTC|WBTC),
//    array order reproduces Curvance's own naming exactly.
//
// A derived tiebreak does NOT reproduce that — ordering the both-borrowable
// markets by debt cap inverts every one of them (`USDC / WMON`, `WBTC / eBTC`).
// So take the order the protocol gives and do not compute one.
// ============================================================================
import { createPublicClient, http, fallback, } from "viem";
/** Chain 143. Curvance is Monad-only and the seed has no other chain. */
export const CURVANCE_CHAIN_ID = 143;
/** The one discovery root. Everything else is reachable from it. */
export const CURVANCE_CENTRAL_REGISTRY = "0x1310f352f1389969Ece6741671c4B919523912fF";
/**
 * Same endpoint list, in the same order, as `providers/src/chains/customChains`.
 * Kept literal rather than imported for the self-containment reason above.
 */
const MONAD_RPCS = [
    "https://rpc-mainnet.monadinfra.com",
    "https://rpc.monad.xyz",
    "https://rpc1.monad.xyz",
    "https://rpc2.monad.xyz",
];
const CENTRAL_REGISTRY_ABI = [
    {
        name: "marketManagers",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address[]" }],
    },
];
const MARKET_MANAGER_ABI = [
    {
        name: "queryTokensListed",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address[]" }],
    },
    // THE borrowability gate. `isBorrowable()` on the cToken is `true` on every
    // live deployment and carries no information; a zero debt cap is what makes a
    // leg collateral-only.
    {
        name: "debtCaps",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "cToken", type: "address" }],
        outputs: [{ type: "uint256" }],
    },
];
const CTOKEN_ABI = [
    {
        name: "asset",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
];
const ERC20_ABI = [
    {
        name: "symbol",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
];
function client() {
    return createPublicClient({
        transport: fallback(MONAD_RPCS.map((u) => http(u))),
    });
}
/**
 * Discover every live market and its two legs.
 *
 * Deliberately NOT batched through Multicall3: our own `MONAD_MULTICALL`
 * constant points at a Uniswap multicall that does not answer `aggregate3`, so
 * a batched read on chain 143 returns empty rather than failing. These are a
 * few dozen calls a handful of times a day — plain reads are fine and cannot
 * silently under-report.
 */
export async function discoverCurvanceMarkets() {
    const pc = client();
    const managers = (await pc.readContract({
        address: CURVANCE_CENTRAL_REGISTRY,
        abi: CENTRAL_REGISTRY_ABI,
        functionName: "marketManagers",
    }));
    const out = [];
    for (const mm of managers) {
        let cTokens;
        try {
            cTokens = (await pc.readContract({
                address: mm,
                abi: MARKET_MANAGER_ABI,
                functionName: "queryTokensListed",
            }));
        }
        catch (e) {
            console.log(`Curvance: ${mm} queryTokensListed failed:`, e?.shortMessage ?? e?.message ?? e);
            continue;
        }
        if (!cTokens?.length)
            continue;
        const legs = [];
        for (const cToken of cTokens) {
            try {
                const underlying = (await pc.readContract({
                    address: cToken,
                    abi: CTOKEN_ABI,
                    functionName: "asset",
                }));
                const symbol = (await pc.readContract({
                    address: underlying,
                    abi: ERC20_ABI,
                    functionName: "symbol",
                }));
                const debtCap = (await pc.readContract({
                    address: mm,
                    abi: MARKET_MANAGER_ABI,
                    functionName: "debtCaps",
                    args: [cToken],
                }));
                legs.push({
                    cToken,
                    underlying,
                    symbol,
                    debtCap,
                    borrowable: debtCap > 0n,
                });
            }
            catch (e) {
                console.log(`Curvance: ${mm} leg ${cToken} failed:`, e?.shortMessage ?? e?.message ?? e);
            }
        }
        // A market whose legs did not all resolve would produce a MISLEADING label
        // (a pair rendered as a single asset), which is worse than no label — the
        // consumer falls back to the raw key and at least knows it is unnamed.
        if (legs.length < 2) {
            console.log(`Curvance: ${mm} resolved only ${legs.length} leg(s) — skipped`);
            continue;
        }
        out.push({ marketManager: mm, legs });
    }
    return out;
}
/**
 * The protocol's own order, unmodified — see the header. `legs` is built in
 * `queryTokensListed` order and is not re-sorted anywhere.
 */
function orderLegs(legs) {
    return legs;
}
/**
 * Build the label maps. Includes the bare `CURVANCE` brand key, which is what a
 * consumer sees before per-market fan-out and what `?lender=CURVANCE` filters
 * on.
 */
export function buildCurvanceLabels(markets) {
    const names = { CURVANCE: "Curvance" };
    const shortNames = { CURVANCE: "Curvance" };
    for (const m of markets) {
        const [a, b] = orderLegs(m.legs);
        // Keys are UPPERCASE hex WITHOUT the 0x, and carry the CHAIN ID — Curvance
        // is `CURVANCE_<chainId>_<MM>`, unlike LlamaLend/Inverse which are
        // `<BRAND>_<ADDR>`. Rebuilding an address from one of these keys must
        // lowercase it: `0x` + uppercase hex is not a valid EIP-55 checksum and
        // viem rejects it.
        const key = `CURVANCE_${CURVANCE_CHAIN_ID}_${m.marketManager.slice(2).toUpperCase()}`;
        names[key] = `Curvance ${a.symbol} / ${b.symbol}`;
        shortNames[key] = `${a.symbol}/${b.symbol}`;
    }
    return { names, shortNames };
}
