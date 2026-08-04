// ============================================================================
// Backfill display labels for Teller pools into data/lender-labels.json.
//
// The nightly `update:dataset` job already writes these — `TellerPoolsUpdater`
// emits labels in the same run that reads the pools on-chain, so a new pool is
// never published nameless. This script is the standalone backfill for when
// `data/teller-pools.json` was updated out of band and you want the labels
// caught up without re-running the on-chain reads.
//
//   names[TELLER_<pool>]      = "Teller <principal> / <collateral>"
//   shortNames[TELLER_<pool>] = "<principal>/<collateral>"
//
// Additive: labels for pools no longer in the roster are left alone, so a user
// still holding a loan in one can read its name.
//
// Usage: `tsx src/update-teller-labels.ts`  (npm run update:teller-labels)
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import { buildTellerLabels } from "./fetch/teller-pools-data.js";
import type { TellerPoolRow } from "./fetch/teller/pools.js";

const LABELS_FILE = "./data/lender-labels.json";
const POOLS_FILE = "./data/teller-pools.json";

async function main() {
  const pools = (readJsonFile(POOLS_FILE) ?? {}) as Record<string, TellerPoolRow[]>;
  const built = buildTellerLabels(pools);

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
  // -1 for the bare TELLER base key.
  console.log(
    `Teller labels: ${Object.keys(built.names).length - 1} pool label(s) + base (${res})`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
