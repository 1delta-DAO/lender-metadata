// Shared label builder for Silo v2 / v3. Emits one entry per silo *side*
// keyed as `SILO_V{N}_<UPPER_SILO_ADDRESS>`, matching the per-side reserve
// uid convention used downstream. The pair name is `<thisSym>/<otherSym>`
// from this side's perspective.
/**
 * Build `{ names, shortNames }` for every silo side in `markets`.
 *
 * @param markets        per-chain list of silo pairs
 * @param version        "V2" or "V3" — drives the enum-name prefix and
 *                       display-name prefix
 * @param longPrefix     e.g. "Silo V2" — used in `names`
 * @param shortPrefix    e.g. "S2"       — used in `shortNames`
 */
export function buildSiloLabels(markets, version, longPrefix, shortPrefix) {
    const names = {};
    const shortNames = {};
    const keyFor = (addr) => `SILO_${version}_${addr.replace(/^0x/, "").toUpperCase()}`;
    for (const pairs of Object.values(markets)) {
        for (const pair of pairs) {
            const a = pair.silo0;
            const b = pair.silo1;
            if (!a?.silo || !b?.silo)
                continue;
            const symA = a.symbol || "?";
            const symB = b.symbol || "?";
            const keyA = keyFor(a.silo);
            const keyB = keyFor(b.silo);
            names[keyA] = `${longPrefix} ${symA}/${symB}`;
            names[keyB] = `${longPrefix} ${symB}/${symA}`;
            shortNames[keyA] = `${shortPrefix} ${symA}/${symB}`;
            shortNames[keyB] = `${shortPrefix} ${symB}/${symA}`;
        }
    }
    return { names, shortNames };
}
