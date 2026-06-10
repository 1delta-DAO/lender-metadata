// ============================================================================
// Populate the MORPHO_BLUE section of data/morpho-type-vaults.json for every
// Morpho Blue chain that has NO Morpho-API coverage, purely from on-chain data.
// Append-only: existing vault entries are never removed.
//
// Two discovery modes:
//   - Factory scan: for each chain in config/morpho-addresses.json that has a
//     `metaMorphoFactory` and is NOT fetched via the Morpho API, enumerate
//     vaults from the factory's `CreateMetaMorpho` events.
//   - Manual:       complete an explicit address list via on-chain
//     `asset()` / `name()`, for no-API chains that have no factory wired in
//     config (e.g. Berachain).
//
// Chains the main MorphoBlueUpdater fetches via the Morpho API are skipped here
// (their vaults come from the API). Chains already covered by the Feather /
// Mystic vault jobs are still scanned — the append-only merge makes the overlap
// harmless and the on-chain scan strictly more complete.
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import {
  fetchMorphoVaultsByAddress,
  fetchMorphoVaultsByEvents,
} from "./fetch/morpho/fetchMorphoVaultsByEvents.js";
import { MORPHO_MAIN_CHAIN_IDS, cannotUseApi } from "./fetch/morpho/morpho.js";
import { FEATHER_CHAIN_IDS } from "./fetch/morpho/fetchFeatherApi.js";
import { MYSTIC_CHAIN_IDS } from "./fetch/morpho/fetchMysticApi.js";
import type {
  MorphoTypeVault,
  MorphoTypeVaultsByFork,
} from "./fetch/morpho/vaultTypes.js";

const VAULTS_FILE = "./data/morpho-type-vaults.json";
const ADDRESSES_FILE = "./config/morpho-addresses.json";
const FORK = "MORPHO_BLUE";

// Chains that genuinely have Morpho API coverage: the main updater walks them
// AND `cannotUseApi` is false. These are skipped (vaults come from the API).
const API_CHAINS = new Set(
  MORPHO_MAIN_CHAIN_IDS.filter((c) => !cannotUseApi(c, FORK)),
);

// Chains already covered by dedicated vault jobs that discover via a hosted
// indexer (update:lista-vaults runs separately too). Skipping them here avoids
// slow, redundant on-chain log scans of chains we already populate cheaply.
const COVERED_BY_OTHER_JOBS = new Set<string>([
  ...FEATHER_CHAIN_IDS,
  ...MYSTIC_CHAIN_IDS,
]);

// No-API chains that have no `metaMorphoFactory` in config: list vaults by
// address and complete them on-chain.
const MANUAL_VAULTS: Record<string, string[]> = {
  // Berachain
  "80094": [
    "0x30BbA9CD9Eb8c95824aa42Faa1Bb397b07545bc1",
    "0xB5f473c4b7F402d8f7bED42b6D516f5ff3306B01",
  ],
};

/** chainId -> metaMorphoFactory for every no-API chain that has one. */
function discoveryTargets(): Record<string, string> {
  const addrs: Record<string, any> = readJsonFile(ADDRESSES_FILE);
  const targets: Record<string, string> = {};
  for (const [chainId, cfg] of Object.entries(addrs)) {
    const factory = cfg?.metaMorphoFactory;
    if (!factory || API_CHAINS.has(chainId) || COVERED_BY_OTHER_JOBS.has(chainId))
      continue;
    targets[chainId] = factory;
  }
  return targets;
}

async function main(): Promise<void> {
  const byChain: Record<string, MorphoTypeVault[]> = {};

  const targets = discoveryTargets();
  const failures: string[] = [];
  console.log(
    `Discovering vaults on ${Object.keys(targets).length} no-API factory chains: ${Object.keys(targets).join(", ")}`,
  );
  await Promise.all(
    Object.entries(targets).map(async ([chainId, factory]) => {
      try {
        const vaults = await fetchMorphoVaultsByEvents(chainId, factory);
        byChain[chainId] = vaults;
        console.log(`  chain ${chainId}: discovered ${vaults.length} vaults`);
      } catch (err) {
        failures.push(chainId);
        console.warn(
          `  chain ${chainId}: discovery failed: ${(err as any)?.message ?? err}`,
        );
      }
    }),
  );

  for (const [chainId, addresses] of Object.entries(MANUAL_VAULTS)) {
    try {
      const vaults = await fetchMorphoVaultsByAddress(chainId, addresses);
      byChain[chainId] = [...(byChain[chainId] ?? []), ...vaults];
      console.log(
        `  chain ${chainId}: read ${vaults.length}/${addresses.length} manual vaults`,
      );
    } catch (err) {
      console.warn(`  chain ${chainId}: manual read failed:`, err);
    }
  }

  let existing: MorphoTypeVaultsByFork = {};
  try {
    existing = readJsonFile(VAULTS_FILE);
  } catch {
    existing = {};
  }
  if (!existing[FORK]) existing[FORK] = {};

  let added = 0;
  let renamed = 0;
  for (const [chainId, vaults] of Object.entries(byChain)) {
    if (vaults.length === 0) continue;
    const current: MorphoTypeVault[] = existing[FORK][chainId] ?? [];
    const known = new Map(current.map((v) => [v.vault.toLowerCase(), v]));

    for (const v of vaults) {
      const addr = v.vault.toLowerCase();
      const entry = known.get(addr);
      if (!entry) {
        known.set(addr, v);
        added++;
      } else if (v.name && entry.name !== v.name) {
        entry.name = v.name;
        renamed++;
      }
    }

    existing[FORK][chainId] = Array.from(known.values()).sort((a, b) =>
      a.vault.localeCompare(b.vault),
    );
  }

  const writeResult = await writeTextIfChanged(
    VAULTS_FILE,
    JSON.stringify(existing, null, 2) + "\n",
  );
  console.log(
    `Added ${added} new vaults, refreshed ${renamed} names; file ${writeResult}.`,
  );
  if (failures.length > 0) {
    console.warn(
      `Could not scan ${failures.length} chain(s) (unreachable RPC or too restrictive to scan in budget): ${failures.join(", ")}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
