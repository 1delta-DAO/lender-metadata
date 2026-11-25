// ============================================================================
// Write the Flex market roster to config/flex.json and its labels to
// data/lender-labels.json. The same discovery runs nightly in update:dataset;
// see `fetch/flex/config.ts`.
//
// Usage: `tsx src/update-flex.ts`  (npm run update:flex)
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import {
  FLEX_CHAIN_ID,
  buildFlexLabels,
  discoverFlexConfig,
} from "./fetch/flex/config.js";

const CONFIG_FILE = "./config/flex.json";
const LABELS_FILE = "./data/lender-labels.json";

async function main() {
  // Throws on any failed read, so nothing is written from a partial answer.
  const chain = await discoverFlexConfig();

  const configRes = await writeTextIfChanged(
    CONFIG_FILE,
    JSON.stringify({ FLEX: { [String(FLEX_CHAIN_ID)]: chain } }, null, 2) +
      "\n",
  );

  const built = buildFlexLabels(chain.markets);
  const labels = readJsonFile(LABELS_FILE) ?? {};
  labels.names ??= {};
  labels.shortNames ??= {};
  Object.assign(labels.names, built.names);
  Object.assign(labels.shortNames, built.shortNames);
  labels.names = sortRecord(labels.names);
  labels.shortNames = sortRecord(labels.shortNames);
  const labelRes = await writeTextIfChanged(
    LABELS_FILE,
    JSON.stringify(labels, null, 2) + "\n",
  );

  console.log(
    `Flex: ${chain.markets.length} endorsed market(s) (${configRes}); labels (${labelRes})`,
  );
  for (const m of chain.markets) {
    console.log(`  ${m.troveManager}  ${m.borrowSymbol} / ${m.collateralSymbol}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
