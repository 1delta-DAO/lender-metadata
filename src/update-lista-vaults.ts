// ============================================================================
// Populate the LISTA_DAO section of data/morpho-type-vaults.json from the
// Lista moolah API. Append-only: existing vault entries are never removed.
// Run as a separate job because the API is access-restricted.
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import {
  fetchListaVaults,
  resolveListaVaultUnderlyings,
} from "./fetch/morpho/fetchListaApi.js";
import type {
  MorphoTypeVault,
  MorphoTypeVaultsByFork,
} from "./fetch/morpho/vaultTypes.js";

const VAULTS_FILE = "./data/morpho-type-vaults.json";
const FORK = "LISTA_DAO";

async function main(): Promise<void> {
  const vaults = await fetchListaVaults();
  const totalFetched = Object.values(vaults).reduce(
    (acc, list) => acc + list.length,
    0,
  );
  console.log(
    `Fetched ${totalFetched} Lista vaults across ${Object.keys(vaults).length} chains`,
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
    const current: MorphoTypeVault[] = existing[FORK][chainId] ?? [];
    const known = new Map(current.map((v) => [v.vault.toLowerCase(), v]));
    const nameByAddr = new Map(
      infos.map((i) => [i.address.toLowerCase(), i.name]),
    );

    // Backfill / refresh names on already-known vaults.
    for (const [addr, entry] of known) {
      const apiName = nameByAddr.get(addr);
      if (apiName && entry.name !== apiName) {
        entry.name = apiName;
        renamed++;
      }
    }

    const toResolve = infos
      .map((i) => i.address)
      .filter((addr) => !known.has(addr));

    if (toResolve.length === 0) {
      existing[FORK][chainId] = Array.from(known.values()).sort((a, b) =>
        a.vault.localeCompare(b.vault),
      );
      continue;
    }

    let underlyings: Record<string, string> = {};
    try {
      underlyings = await resolveListaVaultUnderlyings(chainId, toResolve);
    } catch (err) {
      console.warn(`Underlying resolution failed for chain ${chainId}:`, err);
      continue;
    }

    for (const addr of toResolve) {
      const underlying = underlyings[addr];
      if (!underlying) continue;
      const name = nameByAddr.get(addr);
      known.set(addr, {
        vault: addr,
        underlying,
        ...(name ? { name } : {}),
      });
      added++;
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
    `Added ${added} new Lista vaults, refreshed ${renamed} names; file ${writeResult}.`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
