// ============================================================================
// Populate the MORPHO_BLUE section of data/morpho-type-vaults.json with the
// Mystic Finance vaults on Flare / Plume / Citrea. Append-only: existing
// vault entries are never removed.
//
// Mystic markets are already wired into the main MorphoBlueUpdater via the
// Mystic API path, so labels + market ids land in config/morpho-type-markets
// on the regular update. Vaults need this dedicated job because the main
// pipeline does not populate morpho-type-vaults.json.
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { fetchAllMysticVaults } from "./fetch/morpho/fetchMysticApi.js";
import type {
  MorphoTypeVault,
  MorphoTypeVaultsByFork,
} from "./fetch/morpho/vaultTypes.js";

const VAULTS_FILE = "./data/morpho-type-vaults.json";
const FORK = "MORPHO_BLUE";

async function main(): Promise<void> {
  const vaults = await fetchAllMysticVaults();
  const totalFetched = Object.values(vaults).reduce(
    (acc, list) => acc + list.length,
    0,
  );
  console.log(
    `Fetched ${totalFetched} Mystic vaults across ${Object.keys(vaults).length} chains`,
  );

  let existing: MorphoTypeVaultsByFork = {};
  try {
    existing = readJsonFile(VAULTS_FILE);
  } catch {
    existing = {};
  }
  if (!existing[FORK]) existing[FORK] = {};

  let added = 0;
  let renamed = 0;
  for (const [chainId, infos] of Object.entries(vaults)) {
    if (infos.length === 0) continue;
    const current: MorphoTypeVault[] = existing[FORK][chainId] ?? [];
    const known = new Map(current.map((v) => [v.vault.toLowerCase(), v]));

    for (const info of infos) {
      const addr = info.address.toLowerCase();
      const entry = known.get(addr);
      if (!entry) {
        known.set(addr, {
          vault: addr,
          underlying: info.underlying.toLowerCase(),
          ...(info.name ? { name: info.name } : {}),
        });
        added++;
      } else if (info.name && entry.name !== info.name) {
        entry.name = info.name;
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
    `Added ${added} new Mystic vaults, refreshed ${renamed} names; file ${writeResult}.`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
