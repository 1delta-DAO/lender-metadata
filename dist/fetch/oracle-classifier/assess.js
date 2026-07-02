import { parsePair, symbolsMatch } from "./normalize.js";
/**
 * Compares a resolved feed's reported pair against the asset it is supposed to price
 * and the protocol's numeraire (the unit of account, e.g. "USD" or "ETH").
 *
 * Shared across every lender's classifier — the lender layer only has to supply the
 * intended asset symbol and the numeraire; the matching (incl. wrapped-token aliases)
 * lives here.
 */
export function assessFeed(resolved, assetSymbol, numeraire) {
    const pair = parsePair(resolved.priceDescription);
    const denominator = pair?.quote ?? null;
    const intendedPair = assetSymbol && numeraire ? `${assetSymbol} / ${numeraire}` : null;
    const verifiable = !resolved.fixedRate &&
        !!pair &&
        resolved.priceDescription !== "UNKNOWN" &&
        // composite "X * Y / Z" descriptions don't map to a single asset/numeraire pair
        !resolved.priceDescription.includes(" * ");
    // Pendle PT price-cap adapters resolve to their *numeraire* feed (e.g. USDT/USD),
    // so the terminal pair's base is the numeraire, NOT the PT. Comparing it to the
    // PT symbol would always read as wrong-asset. Instead verify against the adapter's
    // own named underlying (it prices PT-<underlying>); the denominator check below
    // still applies to the numeraire pair as usual.
    if (resolved.provider === "pendle-pt") {
        const correctOracle = ptUnderlyingMatch(resolved.rawDescription, assetSymbol);
        const denominatorMatch = verifiable && numeraire && pair.quote
            ? symbolsMatch(pair.quote, numeraire)
            : null;
        return { denominator, intendedPair, correctOracle, denominatorMatch };
    }
    const correctOracle = verifiable && assetSymbol ? symbolsMatch(pair.base, assetSymbol) : null;
    const denominatorMatch = verifiable && numeraire && pair.quote
        ? symbolsMatch(pair.quote, numeraire)
        : null;
    return { denominator, intendedPair, correctOracle, denominatorMatch };
}
/**
 * Correctness for a Pendle PT price-cap adapter. The adapter's description names
 * the underlying it discounts ("PT Capped <underlying> <feed> linear discount <date>"),
 * and the reserve symbol is "PT-<underlying>-<date>". The feed is correct when those
 * underlyings match (alias-aware).
 *
 *  - true  — adapter underlying matches the PT's underlying.
 *  - false — both are extractable but disagree (genuinely mis-wired adapter).
 *  - null  — could not extract one side (leave unverified rather than falsely flag).
 */
function ptUnderlyingMatch(rawDescription, assetSymbol) {
    if (!rawDescription || !assetSymbol)
        return null;
    // "PT Capped srUSDe USDT/USD …" / "PT srUSDe …" -> "srUSDe"
    const descUnderlying = rawDescription.match(/\bPT\s+(?:capped\s+)?([A-Za-z0-9.]+)/i)?.[1];
    // "PT-srUSDe-25JUN2026" -> "srUSDe" (fallback: strip "PT-" and the trailing date)
    const dated = assetSymbol.match(/^PT-(.+?)-\d{1,2}[A-Za-z]{3,}\d{2,4}$/i);
    const symUnderlying = dated
        ? dated[1]
        : assetSymbol.replace(/^PT-/i, "").replace(/-\d.*$/, "");
    if (!descUnderlying || !symUnderlying)
        return null;
    return symbolsMatch(descUnderlying, symUnderlying);
}
/**
 * The most common denominator across a set of feed pairs == the market's unit of
 * account. Robust against markets whose on-chain BASE_CURRENCY is unreadable (legacy
 * Aave V2 is ETH-denominated but exposes no BASE_CURRENCY()). Returns uppercased.
 */
export function dominantDenominator(denoms) {
    const counts = new Map();
    for (const d of denoms) {
        if (!d)
            continue;
        const key = d.toUpperCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [d, n] of counts) {
        if (n > bestN) {
            best = d;
            bestN = n;
        }
    }
    return best;
}
