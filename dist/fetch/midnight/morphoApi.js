// ============================================================================
// Morpho's hosted Midnight API — the UNIVERSE of the roster (every market on
// the chain, with its live depth and positions), and the source of the fields
// Tenor does not publish (`market_family_id`, `listed`, the fee schedule).
// See MIDNIGHT_UNIVERSE_PLAN.md in lending-sdks.
//
// It reads `GET /markets?chainId=`, NOT `GET /books`. That distinction is the
// whole bug this replaces: `/books` only returns markets with a RESTING ORDER
// BOOK, so a market holding real positions but quoting nothing never entered the
// roster — and every holder's position then read as nothing. A liquidity view is
// not a roster.
// ============================================================================
const big = (v) => {
    try {
        return v === null || v === undefined ? 0n : BigInt(String(v));
    }
    catch {
        return 0n;
    }
};
const str = (v) => v === null || v === undefined ? undefined : String(v);
/**
 * Page through `GET {base}/markets?chain_ids=` for one chain.
 *
 * **The filter is `chain_ids` (snake case, comma list); `chainId=` is silently
 * ignored** and returns every chain — that is how an Ethereum market once
 * landed in Base's roster keyed to Base's `midnight` address, caught only by
 * the market-id re-derivation in the updater. Every row is still filtered
 * client-side on its own `chain_id`. `limit` up to 1000 is accepted (Morpho's
 * whole universe is ~3 pages).
 *
 * Throws on transport failure or an empty result — like the Tenor client, an
 * empty roster must never be mistaken for an authoritative "no markets".
 */
export async function fetchMorphoMidnightMarkets(apiBase, chainId) {
    const base = apiBase.replace(/\/+$/, "");
    const raw = [];
    let cursor = null;
    for (let page = 0; page < 200; page++) {
        const url = `${base}/markets?chain_ids=${encodeURIComponent(chainId)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Midnight markets HTTP ${res.status}`);
        const json = await res.json();
        for (const m of json?.data ?? [])
            raw.push(m);
        cursor = json?.cursor ?? null;
        if (!cursor)
            break;
    }
    // Belt and braces — filter here, before anything trusts a row.
    const forChain = raw.filter((m) => String(m?.chain_id) === String(chainId));
    if (forChain.length === 0)
        throw new Error(`Midnight API returned no markets for chain ${chainId}`);
    const out = [];
    for (const m of forChain) {
        if (!m?.market_id || !m?.loan_token || !Array.isArray(m?.collaterals))
            continue;
        if (m.collaterals.length === 0)
            continue;
        // `settlement_fee_schedule` is an array of {time_to_maturity_days, fee_cbp}
        // in TTM order; we store just the 7 cbp values, matching the on-chain
        // `marketState` layout the updater snapshots.
        const sched = Array.isArray(m.settlement_fee_schedule)
            ? m.settlement_fee_schedule.map((f) => Number(f?.fee_cbp ?? 0))
            : undefined;
        out.push({
            marketId: m.market_id,
            chainId: String(m.chain_id ?? chainId),
            loanToken: m.loan_token,
            collaterals: m.collaterals.map((c) => ({
                token: c.token,
                oracle: c.oracle,
                lltv: String(c.lltv),
                liquidationCursor: String(c.liquidation_cursor),
            })),
            maturity: String(m.maturity),
            rcfThreshold: String(m.rcf_threshold),
            enterGate: m.enter_gate,
            liquidatorGate: m.liquidator_gate,
            settlementFeeCbp: sched && sched.length === 7 ? sched : undefined,
            continuousFee: str(m.continuous_fee_rate),
            marketFamilyId: str(m.market_family_id),
            listed: typeof m.listed === "boolean" ? m.listed : undefined,
            totalUnits: str(m.total_units),
            lendDepth: big(m.lend_depth),
            borrowDepth: big(m.borrow_depth),
        });
    }
    return out;
}
