// ============================================================================
// Write display labels for Curvance markets into data/lender-labels.json.
//
// Unlike every other `update:*-labels` script here, this one is NOT a backfill
// for a markets file — Curvance has no file in this repo at all. Its roster is
// a built-in seed in @1delta/data-sdk (the protocol publishes no market list,
// and Monad's 100-block `eth_getLogs` cap makes the registry events
// unscannable), so labels are the ONLY Curvance artifact this repo owns, and
// this script is their sole source. It discovers the markets on-chain each run.
//
//   names[CURVANCE_143_<MM>]      = "Curvance WMON / USDC"
//   shortNames[CURVANCE_143_<MM>] = "WMON/USDC"
//
// Collateral-first ordering, deliberately unlike the other lenders — see the
// header of `fetch/curvance/labels.ts` for why.
//
// Additive: labels for markets no longer listed are left alone, so a user still
// holding a position in a delisted market can read its name.
//
// Usage: `tsx src/update-curvance-labels.ts`  (npm run update:curvance-labels)
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import {
  discoverCurvanceMarkets,
  buildCurvanceLabels,
} from "./fetch/curvance/labels.js";

const LABELS_FILE = "./data/lender-labels.json";

async function main() {
  const markets = await discoverCurvanceMarkets();
  if (markets.length === 0) {
    // Fail LOUDLY rather than writing an empty label set. Discovery is a live
    // on-chain read with no cached fallback, so "zero markets" is far more
    // likely to be an RPC problem than a delisting of the whole protocol, and
    // silently proceeding would leave the file looking correctly updated.
    console.error(
      "Curvance: discovery returned no markets — refusing to write labels.",
    );
    process.exit(1);
  }

  const built = buildCurvanceLabels(markets);

  const labels = readJsonFile(LABELS_FILE) ?? {};
  labels.names ??= {};
  labels.shortNames ??= {};
  Object.assign(labels.names, built.names);
  Object.assign(labels.shortNames, built.shortNames);
  labels.names = sortRecord(labels.names);
  labels.shortNames = sortRecord(labels.shortNames);

  const res = await writeTextIfChanged(
    LABELS_FILE,
    JSON.stringify(labels, null, 2) + "\n",
  );
  // -1 for the bare CURVANCE brand key.
  console.log(
    `Curvance labels: ${Object.keys(built.names).length - 1} market label(s) + base (${res})`,
  );
  for (const [k, v] of Object.entries(built.names)) console.log(`  ${k} = ${v}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
