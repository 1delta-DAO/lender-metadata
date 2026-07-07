// ============================================================================
// Scoped Aave-fork data refresh: regenerate the reserves / tokens / price-oracle
// / classified-oracle data for a SPECIFIC set of chain ids and merge the result
// into the existing data files. Append-style: other chains are left untouched.
//
// Use this when a market is added on a new chain (e.g. Avalon / Zona on Pharos
// 1672) and you only want that chain's Aave data generated, without refetching
// every Aave-fork chain via the full `update:dataset` pipeline.
//
// It drives the same fetchers the AaveUpdater uses, scoped through the shared
// `AAVE_CHAIN_FILTER` env var (read by fetchReserves / fetchOracles /
// classifyOracles). Because those fetchers key data by fork→chain, a scoped run
// yields only the targeted chains, and the per-file `mergeData` deep-merges them
// into the existing files. The classified-oracle updater normally REPLACES its
// whole file, so we merge here explicitly to avoid dropping other chains.
//
// Usage: tsx src/update-aave-chain.ts <chainId> [chainId...]
//   e.g. tsx src/update-aave-chain.ts 1672
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { loadExisting, mergeData } from "./utils.js";

const TOKENS_FILE = "./data/aave-tokens.json";
const RESERVES_FILE = "./data/aave-reserves.json";
const ORACLES_FILE = "./data/aave-oracles.json";
const CLASSIFIED_FILE = "./data/aave-oracles-classified.json";

async function mergeWrite(file: string, incoming: any): Promise<void> {
  let existing: any = {};
  try {
    existing = await loadExisting(file);
  } catch {
    existing = {};
  }
  const merged = mergeData(existing, incoming);
  const result = await writeTextIfChanged(
    file,
    JSON.stringify(merged, null, 2) + "\n",
  );
  console.log(`  ${file}: ${result}`);
}

async function main(): Promise<void> {
  const chains = process.argv.slice(2);
  if (chains.length === 0) {
    console.error("usage: tsx src/update-aave-chain.ts <chainId> [chainId...]");
    process.exit(1);
  }
  // Set the scope BEFORE the fetchers load — they capture AAVE_CHAIN_FILTER at
  // module init, so the imports must be dynamic and come after this assignment.
  process.env.AAVE_CHAIN_FILTER = chains.join(",");
  console.log(`Refreshing Aave data for chain(s): ${chains.join(", ")}`);

  const { fetchAaveTypeTokenData } = await import("./fetch/aave/fetchReserves.js");
  const { fetchAaveTypePriceOracles } = await import("./fetch/aave/fetchOracles.js");

  // 1. reserves + tokens (+ the pool config, unchanged) then price oracles.
  const { reserves, tokens, AAVE_FORK_POOL_DATA } =
    await fetchAaveTypeTokenData();
  const oracles = await fetchAaveTypePriceOracles(AAVE_FORK_POOL_DATA);

  // Write the base files first — classifyAaveOracles reads aave-oracles.json and
  // aave-reserves.json off disk.
  await mergeWrite(TOKENS_FILE, tokens);
  await mergeWrite(RESERVES_FILE, reserves);
  await mergeWrite(ORACLES_FILE, oracles);

  // 2. classify the (scoped) oracles and merge into the classified file.
  const { classifyAaveOracles } = await import("./fetch/aave/classifyOracles.js");
  const classified = await classifyAaveOracles();
  await mergeWrite(CLASSIFIED_FILE, classified);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
