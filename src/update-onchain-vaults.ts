// ============================================================================
// Populate the MORPHO_BLUE section of data/morpho-type-vaults.json for Morpho
// Blue chains that have no Morpho-API / Feather / Mystic vault coverage, purely
// from on-chain data. Append-only: existing vault entries are never removed.
//
// Two discovery modes:
//   - DISCOVER_CHAINS: scan a MetaMorpho factory's `CreateMetaMorpho` events to
//     enumerate every vault on the chain (e.g. Abstract).
//   - MANUAL_VAULTS:   complete an explicit address list via on-chain
//     `asset()` / `name()`, for chains with no factory wired in config
//     (e.g. Berachain).
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import {
  fetchMorphoVaultsByAddress,
  fetchMorphoVaultsByEvents,
} from "./fetch/morpho/fetchMorphoVaultsByEvents.js";
import type {
  MorphoTypeVault,
  MorphoTypeVaultsByFork,
} from "./fetch/morpho/vaultTypes.js";

const VAULTS_FILE = "./data/morpho-type-vaults.json";
const FORK = "MORPHO_BLUE";

// chainId -> MetaMorpho factory address (vaults discovered from its events).
const DISCOVER_CHAINS: Record<string, string> = {
  "2741": "0x83A7f60c9fc57cEf1e8001bda98783AA1A53E4b1", // Abstract
};

// chainId -> explicit vault addresses (no factory in config; read on-chain).
const MANUAL_VAULTS: Record<string, string[]> = {
  // Berachain
  "80094": [
    "0x30BbA9CD9Eb8c95824aa42Faa1Bb397b07545bc1",
    "0xB5f473c4b7F402d8f7bED42b6D516f5ff3306B01",
  ],
};

async function main(): Promise<void> {
  const byChain: Record<string, MorphoTypeVault[]> = {};

  for (const [chainId, factory] of Object.entries(DISCOVER_CHAINS)) {
    try {
      const vaults = await fetchMorphoVaultsByEvents(chainId, factory);
      byChain[chainId] = vaults;
      console.log(`Discovered ${vaults.length} vaults on chain ${chainId}`);
    } catch (err) {
      console.warn(`Vault discovery failed for chain ${chainId}:`, err);
    }
  }

  for (const [chainId, addresses] of Object.entries(MANUAL_VAULTS)) {
    try {
      const vaults = await fetchMorphoVaultsByAddress(chainId, addresses);
      byChain[chainId] = [...(byChain[chainId] ?? []), ...vaults];
      console.log(
        `Read ${vaults.length}/${addresses.length} manual vaults on chain ${chainId}`,
      );
    } catch (err) {
      console.warn(`Vault read failed for chain ${chainId}:`, err);
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

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
