// ============================================================================
// Write display labels for Fraxlend pairs into data/lender-labels.json.
//
//   names[FRAXLEND_1_<PAIR>]      = "Fraxlend frxUSD / sfrxETH"
//   shortNames[FRAXLEND_1_<PAIR>] = "frxUSD / sfrxETH"
//
// `<asset> / <collateral>` — the borrowable side first. That satisfies both the
// LlamaLend/TermMax/Teller `<debt> / <collateral>` convention and Fraxlend's own
// asset-first symbols (`ffrxUSD(sfrxETH)-58`); see the header of
// `fetch/fraxlend/labels.ts`. Deliberately the opposite of the Curvance labels
// in this repo, which are collateral-first for reasons that do not apply here.
//
// The roster is read from this repo's own `config/fraxlend.json`; the symbols
// are resolved on-chain so a hand-written label cannot drift from what the pair
// actually holds.
//
// Additive: labels for pairs no longer on the allowlist are left alone, so a
// user still holding a position in a de-listed pair can read its name.
//
// Usage: `tsx src/update-fraxlend-labels.ts`  (npm run update:fraxlend-labels)
// ============================================================================
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import { discoverFraxlendPairs, buildFraxlendLabels, } from "./fetch/fraxlend/labels.js";
const LABELS_FILE = "./data/lender-labels.json";
async function main() {
    const pairs = await discoverFraxlendPairs();
    if (pairs.length === 0) {
        // Fail LOUDLY rather than writing a label set containing only the brand
        // key. The roster is a checked-in file, so "zero pairs" means either the
        // config was emptied or every on-chain read failed — both are problems to
        // surface, not to paper over with a file that looks correctly updated.
        console.error("Fraxlend: no pairs resolved — refusing to write labels.");
        process.exit(1);
    }
    const built = buildFraxlendLabels(pairs);
    const labels = readJsonFile(LABELS_FILE) ?? {};
    labels.names ??= {};
    labels.shortNames ??= {};
    Object.assign(labels.names, built.names);
    Object.assign(labels.shortNames, built.shortNames);
    labels.names = sortRecord(labels.names);
    labels.shortNames = sortRecord(labels.shortNames);
    const res = await writeTextIfChanged(LABELS_FILE, JSON.stringify(labels, null, 2) + "\n");
    // -1 for the bare FRAXLEND brand key.
    console.log(`Fraxlend labels: ${Object.keys(built.names).length - 1} pair label(s) + base (${res})`);
    for (const [k, v] of Object.entries(built.names))
        console.log(`  ${k} = ${v}`);
    process.exit(0);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
