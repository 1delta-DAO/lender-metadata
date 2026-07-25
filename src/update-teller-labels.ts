// ============================================================================
// Backfill display labels for Teller pools into data/lender-labels.json.
//
// Teller pools are per-pool lender keys `TELLER_<POOL_ADDRESS_HEX_UPPER>` (the
// margin-fetcher synthesizes them). The frontend resolves the dropdown/market
// name from `lender-labels.json` (`names` / `shortNames`), so without an entry a
// pool renders as the raw `TELLER_E6AB9D0C…` key. This reads the published
// `data/teller-pools.json` (which carries on-chain-accurate principal/collateral
// symbols) and writes one label per pool, plus the base `TELLER` label:
//   names[TELLER_<pool>]      = "Teller <principal> / <collateral>"
//   shortNames[TELLER_<pool>] = "<principal>/<collateral>"
//
// Run AFTER `update:teller` (which fixes the token symbols on-chain).
// Usage: `tsx src/update-teller-labels.ts`  (npm run update:teller-labels)
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";

const LABELS_FILE = "./data/lender-labels.json";
const POOLS_FILE = "./data/teller-pools.json";

const tellerKey = (pool: string): string =>
  `TELLER_${pool.replace(/^0x/i, "").toUpperCase()}`;

async function main() {
  const pools = (readJsonFile(POOLS_FILE) ?? {}) as Record<
    string,
    Array<{
      pool: string;
      principalSymbol?: string;
      collateralSymbol?: string;
      name?: string;
    }>
  >;
  const labels = readJsonFile(LABELS_FILE) ?? {};
  labels.names ??= {};
  labels.shortNames ??= {};

  // Base lender label.
  labels.names.TELLER = "Teller";
  labels.shortNames.TELLER = "Teller";

  let count = 0;
  for (const rows of Object.values(pools)) {
    for (const p of rows ?? []) {
      if (!p?.pool) continue;
      const ps = p.principalSymbol ?? "?";
      const cs = p.collateralSymbol ?? "?";
      const key = tellerKey(p.pool);
      labels.names[key] = p.name ?? `Teller ${ps} / ${cs}`;
      labels.shortNames[key] = `${ps}/${cs}`;
      count++;
    }
  }

  labels.names = sortRecord(labels.names);
  labels.shortNames = sortRecord(labels.shortNames);

  const res = await writeTextIfChanged(
    LABELS_FILE,
    JSON.stringify(labels, null, 2) + "\n",
  );
  console.log(`Teller labels: ${count} pool label(s) + base (${res})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
