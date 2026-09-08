// ============================================================================
// Populate the MORPHO_BLUE section of data/morpho-type-vaults.json for every
// Morpho Blue chain that has NO Morpho-API coverage, purely from on-chain data.
// Append-only: existing vault entries are never removed.
//
// Three discovery modes:
//   - v1 factory scan: for each no-API chain in config/morpho-addresses.json
//     with a `metaMorphoFactory`, enumerate vaults from its `CreateMetaMorpho`
//     events.
//   - v2 factory scan: for each no-API chain with a `vaultV2Factory` (e.g.
//     Pharos, which has no MetaMorpho v1 factory), enumerate vaults from its
//     `CreateVaultV2` events (name filled in with a follow-up `name()` read).
//   - Manual:          complete an explicit address list via on-chain
//     `asset()` / `name()`, for no-API chains that have no factory wired in
//     config (e.g. Berachain).
//
// Chains the main MorphoBlueUpdater fetches via the Morpho API are skipped here
// (their vaults come from the API), as are chains a dedicated hosted-indexer
// vault job already populates.
//
// The MYSTIC chains are NOT among the latter any more. `update:mystic-vaults`
// is the job that was supposed to cover them, and since 2026-09 it cannot:
// `morphoCache` requires an x-api-key nobody holds, so it skips. Excluding
// them here on the strength of that job left Morpho vaults on Flare, Plume and
// Citrea discovered by NOBODY, with no error on either side — the same shape
// as the market-id gap in `update-onchain-markets.ts`.
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import {
  fetchMorphoVaultsByAddress,
  fetchMorphoVaultsByEvents,
  fetchMorphoVaultV2ByEvents,
} from "./fetch/morpho/fetchMorphoVaultsByEvents.js";
import { MORPHO_MAIN_CHAIN_IDS, cannotUseApi } from "./fetch/morpho/morpho.js";
import { FEATHER_CHAIN_IDS } from "./fetch/morpho/fetchFeatherApi.js";
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
const COVERED_BY_OTHER_JOBS = new Set<string>([...FEATHER_CHAIN_IDS]);

// Vaults listed by address and completed on-chain. Two reasons to be here:
// a no-API chain with no `metaMorphoFactory` in config (Berachain), or a vault
// no indexer carries (Longbow, below) — this loop is deliberately NOT filtered
// by `API_CHAINS`, so an API chain can still name individual vaults the API
// misses.
//
// An entry may be a bare address, or `{ address, name }` when the vault
// publishes NO name on-chain. `name()` is settable post-deploy on a Vault V2
// and Longbow never set it, so all three of theirs answer the empty string —
// which is also why `blue-api`'s `vaultV2s` does not carry them (it returns 26
// vaults for 4663 and none of these). Discovered nameless they would be three
// blank, mutually indistinguishable rows, the failure `identityCollisions`
// exists to catch. The fallback name is the curator's own published one
// (`longbow.cash/api/v2/vaults`), used ONLY when the chain answers nothing —
// an on-chain name always wins, so this self-heals if they ever set one.
type ManualVault = string | { address: string; name: string };
const MANUAL_VAULTS: Record<string, ManualVault[]> = {
  // Berachain
  "80094": [
    "0x30BbA9CD9Eb8c95824aa42Faa1Bb397b07545bc1",
    "0xB5f473c4b7F402d8f7bED42b6D516f5ff3306B01",
  ],
  // Robinhood Chain — Longbow's three curator vaults (Vault V2, unnamed
  // on-chain). See LONGBOW.md in lending-sdks.
  "4663": [
    { address: "0x026df18fbd2A7639089D0a16293383ec687A5Ca1", name: "Longbow Core USDG" },
    { address: "0x65dC90cd3a0BCDE967c8AE6019d6790b616E78F7", name: "Longbow Frontier USDG" },
    { address: "0xe129D4Cb2d454C4ACFAc909d1576453A9b835f61", name: "Longbow ETH" },
  ],
};

// Optional CLI chain-id filter (e.g. `tsx src/update-onchain-vaults.ts 1672`);
// scans every no-API factory chain when empty. Lets a single chain be refreshed
// without walking (and waiting on) every other chain's log history.
const CHAIN_FILTER = new Set(process.argv.slice(2));

/** chainId -> factory address for every no-API chain that has `field`. */
function discoveryTargets(
  field: "metaMorphoFactory" | "vaultV2Factory",
): Record<string, string> {
  const addrs: Record<string, any> = readJsonFile(ADDRESSES_FILE);
  const targets: Record<string, string> = {};
  for (const [chainId, cfg] of Object.entries(addrs)) {
    const factory = cfg?.[field];
    if (!factory || API_CHAINS.has(chainId) || COVERED_BY_OTHER_JOBS.has(chainId))
      continue;
    if (CHAIN_FILTER.size && !CHAIN_FILTER.has(chainId)) continue;
    targets[chainId] = factory;
  }
  return targets;
}

async function main(): Promise<void> {
  const byChain: Record<string, MorphoTypeVault[]> = {};

  const failures: string[] = [];

  const append = (chainId: string, vaults: MorphoTypeVault[]) => {
    byChain[chainId] = [...(byChain[chainId] ?? []), ...vaults];
  };

  // MetaMorpho v1 factories (CreateMetaMorpho).
  const v1Targets = discoveryTargets("metaMorphoFactory");
  console.log(
    `Discovering v1 vaults on ${Object.keys(v1Targets).length} no-API factory chains: ${Object.keys(v1Targets).join(", ")}`,
  );
  await Promise.all(
    Object.entries(v1Targets).map(async ([chainId, factory]) => {
      try {
        const vaults = await fetchMorphoVaultsByEvents(chainId, factory);
        append(chainId, vaults);
        console.log(`  chain ${chainId}: discovered ${vaults.length} v1 vaults`);
      } catch (err) {
        failures.push(chainId);
        console.warn(
          `  chain ${chainId}: v1 discovery failed: ${(err as any)?.message ?? err}`,
        );
      }
    }),
  );

  // Vaults V2 factories (CreateVaultV2) — some no-API chains (e.g. Pharos) have
  // only a Vaults V2 factory and no MetaMorpho v1 factory.
  const v2Targets = discoveryTargets("vaultV2Factory");
  console.log(
    `Discovering v2 vaults on ${Object.keys(v2Targets).length} no-API factory chains: ${Object.keys(v2Targets).join(", ")}`,
  );
  await Promise.all(
    Object.entries(v2Targets).map(async ([chainId, factory]) => {
      try {
        const vaults = await fetchMorphoVaultV2ByEvents(chainId, factory);
        append(chainId, vaults);
        console.log(`  chain ${chainId}: discovered ${vaults.length} v2 vaults`);
      } catch (err) {
        failures.push(chainId);
        console.warn(
          `  chain ${chainId}: v2 discovery failed: ${(err as any)?.message ?? err}`,
        );
      }
    }),
  );

  for (const [chainId, entries] of Object.entries(MANUAL_VAULTS)) {
    if (CHAIN_FILTER.size && !CHAIN_FILTER.has(chainId)) continue;
    const addresses = entries.map((e) =>
      typeof e === "string" ? e : e.address,
    );
    const fallbackNames = new Map(
      entries
        .filter((e): e is { address: string; name: string } => typeof e !== "string")
        .map((e) => [e.address.toLowerCase(), e.name]),
    );
    try {
      const vaults = await fetchMorphoVaultsByAddress(chainId, addresses);
      // Only where the chain answered nothing — never override an on-chain name.
      for (const v of vaults) {
        if (!v.name) {
          const fallback = fallbackNames.get(v.vault.toLowerCase());
          if (fallback) v.name = fallback;
        }
      }
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
