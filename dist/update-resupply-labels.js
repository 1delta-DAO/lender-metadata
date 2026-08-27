// ============================================================================
// Write display labels for Resupply pairs into data/lender-labels.json.
//
// Like `update-curvance-labels.ts`, this is NOT a backfill for a markets file —
// Resupply has no file in this repo. Its roster lives on-chain behind
// `ResupplyRegistry.getAllPairAddresses()` and its deployment seed is a
// built-in in @1delta/data-sdk, so labels are the only Resupply artifact here
// and this script is their sole source. It discovers the pairs on-chain.
//
//   names[RESUPPLY_1_<PAIR>]      = "Resupply CurveLend: crvUSD/sfrxUSD"
//   shortNames[RESUPPLY_1_<PAIR>] = "CurveLend: crvUSD/sfrxUSD"
//
// The label names the WRAPPED market, not Resupply's own two rows — those are
// reUSD/crvUSD on every CurveLend pair and would render all 16 identically.
// See the header of `fetch/resupply/labels.ts`.
//
// Additive: labels for pairs no longer listed are left alone, so a user still
// holding a position in a retired pair can read its name.
//
// Usage: `tsx src/update-resupply-labels.ts`  (npm run update:resupply-labels)
// ============================================================================
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import { discoverResupplyPairs, buildResupplyLabels, } from "./fetch/resupply/labels.js";
const LABELS_FILE = "./data/lender-labels.json";
async function main() {
    const pairs = await discoverResupplyPairs();
    if (pairs.length === 0) {
        // Fail LOUDLY rather than writing an empty label set: discovery is a live
        // on-chain read with no cached fallback, so "zero pairs" is far more likely
        // to be an RPC problem than a delisting of the whole protocol, and silently
        // proceeding would leave the file looking correctly updated.
        console.error("Resupply: discovery returned no pairs — refusing to write labels.");
        process.exit(1);
    }
    const built = buildResupplyLabels(pairs);
    const labels = readJsonFile(LABELS_FILE) ?? {};
    labels.names ??= {};
    labels.shortNames ??= {};
    Object.assign(labels.names, built.names);
    Object.assign(labels.shortNames, built.shortNames);
    labels.names = sortRecord(labels.names);
    labels.shortNames = sortRecord(labels.shortNames);
    const res = await writeTextIfChanged(LABELS_FILE, JSON.stringify(labels, null, 2) + "\n");
    // -1 for the bare RESUPPLY brand key.
    console.log(`Resupply labels: ${Object.keys(built.names).length - 1} pair label(s) + base (${res})`);
    for (const p of pairs)
        console.log(`  ${p.label}  <-  ${p.rawName}`);
    process.exit(0);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
