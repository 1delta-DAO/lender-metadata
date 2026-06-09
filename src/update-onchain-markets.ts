// ============================================================================
// Fill config/morpho-type-markets.json with market ids discovered directly
// from the Morpho Blue core's `CreateMarket` events, for chains that have a
// deployment in config/morpho-addresses.json but no API/subgraph/Mystic
// coverage (so the main MorphoBlueUpdater leaves them empty). Append-only.
//
// Target chains default to the on-chain-only set below; pass chain ids as CLI
// args to override (e.g. `tsx src/update-onchain-markets.ts 8217 5042`).
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { fetchMorphoMarketsByEvents } from "./fetch/morpho/fetchMorphoMarketsByEvents.js";

const ADDRESSES_FILE = "./config/morpho-addresses.json";
const MARKETS_FILE = "./config/morpho-type-markets.json";
const FORK = "MORPHO_BLUE";

/** Chains with a Morpho core but no hosted (API/subgraph/Mystic) market source. */
const DEFAULT_CHAINS = ["8217"]; // Kaia

async function main(): Promise<void> {
  const target = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_CHAINS;

  const addresses: Record<string, { morpho?: string }> =
    readJsonFile(ADDRESSES_FILE);

  let markets: Record<string, Record<string, string[]>> = {};
  try {
    markets = readJsonFile(MARKETS_FILE);
  } catch {
    markets = {};
  }
  if (!markets[FORK]) markets[FORK] = {};

  let added = 0;
  for (const chainId of target) {
    const core = addresses[chainId]?.morpho;
    if (!core) {
      console.warn(`No Morpho core in morpho-addresses for chain ${chainId}`);
      continue;
    }
    let found;
    try {
      found = await fetchMorphoMarketsByEvents(chainId, core);
    } catch (err) {
      console.warn(`Market enumeration failed for chain ${chainId}:`, err);
      continue;
    }
    const existing = new Set(
      (markets[FORK][chainId] ?? []).map((s) => s.toLowerCase()),
    );
    const before = existing.size;
    for (const m of found) existing.add(m.id);
    added += existing.size - before;
    markets[FORK][chainId] = [...existing].sort((a, b) => a.localeCompare(b));
    console.log(
      `chain ${chainId}: core ${core} -> ${found.length} real markets (${existing.size} total)`,
    );
  }

  const writeResult = await writeTextIfChanged(
    MARKETS_FILE,
    JSON.stringify(markets, null, 2) + "\n",
  );
  console.log(`Added ${added} new market ids; file ${writeResult}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
