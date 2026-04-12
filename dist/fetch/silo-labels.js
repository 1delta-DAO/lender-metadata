// Shared label builder for Silo v2 / v3. Emits one entry per silo *side*
// keyed as `SILO_V{N}_<UPPER_SILO_ADDRESS>`, matching the per-side reserve
// uid convention used downstream. The pair name is `<thisSym>/<otherSym>`
// from this side's perspective.
//
// Both the v2 and v3 updaters call `buildAllSiloLabels` with the raw
// `GqlSilo[]` from `fetchAllSilos()` and emit the *complete* v2+v3 label
// set. This is intentional: both updaters write to the same
// `lender-labels.json` file, and the data-manager loads each updater's
// existing-on-disk state independently before merging — so a per-version
// label set would be clobbered when the second updater writes. Emitting
// the full set from both makes the merge order-independent.
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
const PREFIXES = {
    v2: { long: "Silo V2", short: "S2", version: "V2" },
    v3: { long: "Silo V3", short: "S3", version: "V3" },
};
/**
 * Build labels for every silo in `rawSilos` regardless of version. Both
 * updaters call this with the same `fetchAllSilos()` output so the
 * resulting `lender-labels.json` is identical no matter which updater
 * writes last.
 */
export function buildAllSiloLabels(rawSilos) {
    const names = {};
    const shortNames = {};
    for (const s of rawSilos) {
        const v = s.protocol?.protocolVersion;
        if (v !== "v2" && v !== "v3")
            continue;
        if (!s.market1 || !s.market2)
            continue;
        const cfg = PREFIXES[v];
        const keyFor = (addr) => `SILO_${cfg.version}_${addr.replace(/^0x/, "").toUpperCase()}`;
        // Order sides by `index` so the slash-separated name is deterministic
        // (silo0 first, silo1 second).
        const byIndex = {};
        for (const m of [s.market1, s.market2]) {
            byIndex[m.index] = {
                id: m.id,
                sym: m.inputToken?.symbol || "?",
            };
        }
        const a = byIndex[0];
        const b = byIndex[1];
        if (!a || !b)
            continue;
        const keyA = keyFor(a.id);
        const keyB = keyFor(b.id);
        names[keyA] = `${cfg.long} ${a.sym}/${b.sym}`;
        names[keyB] = `${cfg.long} ${b.sym}/${a.sym}`;
        shortNames[keyA] = `${cfg.short} ${a.sym}/${b.sym}`;
        shortNames[keyB] = `${cfg.short} ${b.sym}/${a.sym}`;
    }
    return { names, shortNames };
}
