// ============================================================================
// Standalone refresh of the per-deployment e-mode COUNT on
// `config/aave-pools.json`. The daily `update:dataset` run does this as part of
// the Aave updater; this entry point exists to re-probe on demand — e.g. after
// a governance vote adds a category — without refetching every reserve, token
// and oracle in the Aave book.
//
// Scoped by the shared `AAVE_CHAIN_FILTER` env var, like update-aave-chain.ts:
//   tsx src/update-aave-emodes.ts            # every chain
//   tsx src/update-aave-emodes.ts 1 9745     # only these chains
//
// Deployments whose probe was not clean are left untouched — see fetchEModes.ts
// on why a partial answer must never be written.
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { mergeData } from "./utils.js";
import { readJsonFile } from "./fetch/utils/index.js";

const POOLS_FILE = "./config/aave-pools.json";

async function main(): Promise<void> {
  const chains = process.argv.slice(2);
  if (chains.length) {
    // Set the scope BEFORE the fetcher loads — it captures AAVE_CHAIN_FILTER at
    // module init, so the import must be dynamic and come after this.
    process.env.AAVE_CHAIN_FILTER = chains.join(",");
    console.log(`Probing e-modes for chain(s): ${chains.join(", ")}`);
  } else {
    console.log("Probing e-modes for every Aave-fork chain");
  }

  const { fetchAaveEModeCounts } = await import("./fetch/aave/fetchEModes.js");

  const pools = readJsonFile(POOLS_FILE);
  const counts = await fetchAaveEModeCounts(pools);
  const merged = mergeData(pools, counts);

  const result = await writeTextIfChanged(
    POOLS_FILE,
    JSON.stringify(merged, null, 2) + "\n",
  );
  console.log(`  ${POOLS_FILE}: ${result}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
