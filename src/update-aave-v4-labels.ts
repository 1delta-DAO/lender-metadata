// ============================================================================
// Write display labels for Aave V4 spokes into data/lender-labels.json, and
// keep the curated spoke names in config/aave-v4-peripherals.json in sync.
//
// Each V4 spoke is its own lender (`aave-v4-<spoke>` -> `AAVE_V4_<SPOKE>`), and
// nothing generated those keys before this script — see the header of
// `fetch/aave/v4SpokeLabels.ts` for why the Aave GraphQL API is the only place
// the names exist. `update:aave-v4-pm-names` is unrelated: it names position
// managers, not lenders.
//
// Two files, because a spoke name has two jobs:
//
//   config/aave-v4-peripherals.json  perSpoke[spoke].spokeName
//       feeds `label` on data/aave-v4-spokes.json via update:dataset
//   data/lender-labels.json          names/shortNames[AAVE_V4_<SPOKE>]
//       what the UI renders
//
// Writing only the second would leave the spokes file showing the synthetic
// `Spoke 0x774b..e989` placeholder forever, so both are updated here.
//
// Additive on labels: keys for spokes the API no longer lists are left alone,
// so a user still holding a position in a retired spoke can read its name.
//
// Newly discovered spokes get a full peripherals entry, position managers
// included — the API returns "Unknown" for the Giver/Taker/Config trio, so run
// `npm run update:aave-v4-pm-names` afterwards (this script says so when it
// adds one).
//
// Usage: `tsx src/update-aave-v4-labels.ts`  (npm run update:aave-v4-labels)
// Override the endpoint with AAVE_GRAPHQL_URL.
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import {
  buildAaveV4Labels,
  discoverAaveV4SpokeNames,
  fetchSpokePositionManagers,
  isPlaceholderSpokeLabel,
} from "./fetch/aave/v4SpokeLabels.js";

const LABELS_FILE = "./data/lender-labels.json";
const PERIPHERALS_FILE = "./config/aave-v4-peripherals.json";
const SPOKES_FILE = "./data/aave-v4-spokes.json";

type PerSpokeEntry = {
  spokeName?: string;
  spokeId?: string;
  positionManagers?: { name: string; address: string; active: boolean }[];
};

async function main() {
  const discovered = await discoverAaveV4SpokeNames();
  if (discovered.length === 0) {
    // Fail LOUDLY rather than writing nothing and reporting success: the API is
    // the sole name source with no cached fallback, so "zero spokes" means the
    // endpoint is down or its schema moved, never that Aave delisted every
    // spoke on every hub.
    console.error(
      "Aave V4: the GraphQL API returned no spokes on any seeded hub — refusing to write labels.",
    );
    process.exit(1);
  }

  // ---------------------------------------------------------------------
  // 1. config/aave-v4-peripherals.json — curated spoke names
  // ---------------------------------------------------------------------
  const peripherals = readJsonFile(PERIPHERALS_FILE) as Record<
    string,
    {
      nativeGateway?: string;
      signatureGateway?: string;
      perHub?: Record<string, unknown>;
      perSpoke?: Record<string, PerSpokeEntry>;
    }
  >;

  const renamed: string[] = [];
  const added: string[] = [];

  for (const s of discovered) {
    if (!s.name) continue;

    peripherals[s.chainId] ??= { nativeGateway: "", signatureGateway: "" };
    const chain = peripherals[s.chainId];
    chain.perSpoke ??= {};

    const existing = chain.perSpoke[s.spoke];
    if (!existing) {
      // A spoke we have never recorded: fetch its PMs so the entry is complete
      // on arrival rather than a name with an empty manager list.
      let positionManagers: PerSpokeEntry["positionManagers"] = [];
      try {
        positionManagers = await fetchSpokePositionManagers(s.spokeId);
      } catch (e: any) {
        console.warn(
          `[aave-v4-labels] chain ${s.chainId} spoke ${s.spoke}: position-manager query failed ` +
            `(${e?.message ?? e}) — entry written without managers`,
        );
      }
      chain.perSpoke[s.spoke] = {
        spokeName: s.name,
        spokeId: s.spokeId,
        positionManagers,
      };
      added.push(`${s.chainId}:${s.spoke} "${s.name}" (${positionManagers.length} PM(s))`);
      continue;
    }

    if (s.spokeId && existing.spokeId !== s.spokeId) existing.spokeId = s.spokeId;
    if (existing.spokeName !== s.name) {
      renamed.push(`${s.chainId}:${s.spoke} "${existing.spokeName ?? ""}" -> "${s.name}"`);
      existing.spokeName = s.name;
    }
  }

  const periphRes = await writeTextIfChanged(
    PERIPHERALS_FILE,
    JSON.stringify(peripherals, null, 2) + "\n",
  );

  // ---------------------------------------------------------------------
  // 2. data/lender-labels.json — the display labels
  // ---------------------------------------------------------------------
  // Names already persisted on the spokes file back-fill anything the API did
  // not return this run (a hub whose query failed above), so a partial fetch
  // can only ever add labels, never regress the set we can produce.
  const spokesJson = readJsonFile(SPOKES_FILE) as Record<
    string,
    Record<string, { label?: string }>
  >;
  const fromSpokesFile: { spoke: string; name: string }[] = [];
  for (const chainId of Object.keys(spokesJson ?? {})) {
    for (const [spoke, entry] of Object.entries(spokesJson[chainId] ?? {})) {
      if (!isPlaceholderSpokeLabel(entry?.label)) {
        fromSpokesFile.push({ spoke, name: String(entry.label) });
      }
    }
  }

  // API last so a live rename wins over the value cached on the spokes file.
  const built = buildAaveV4Labels([
    ...fromSpokesFile,
    ...discovered.map((s) => ({ spoke: s.spoke, name: s.name })),
  ]);

  const labels = readJsonFile(LABELS_FILE) ?? {};
  labels.names ??= {};
  labels.shortNames ??= {};

  const newKeys = Object.keys(built.names).filter((k) => !(k in labels.names));

  Object.assign(labels.names, built.names);
  Object.assign(labels.shortNames, built.shortNames);
  labels.names = sortRecord(labels.names);
  labels.shortNames = sortRecord(labels.shortNames);

  const labelsRes = await writeTextIfChanged(
    LABELS_FILE,
    JSON.stringify(labels, null, 2) + "\n",
  );

  // ---------------------------------------------------------------------
  // 3. Report
  // ---------------------------------------------------------------------
  console.log(
    `Aave V4 labels: ${Object.keys(built.names).length} spoke label(s), ` +
      `${newKeys.length} new (${labelsRes})`,
  );
  for (const k of newKeys) console.log(`  + ${k} = ${built.names[k]}`);

  console.log(`Aave V4 peripherals (${periphRes}): ${added.length} spoke(s) added, ${renamed.length} renamed`);
  for (const a of added) console.log(`  + ${a}`);
  for (const r of renamed) console.log(`  ~ ${r}`);

  if (added.length > 0) {
    console.log(
      "\nNew spokes carry API position-manager names, where Giver/Taker/Config " +
        'come back as "Unknown". Run `npm run update:aave-v4-pm-names` to classify them.',
    );
  }

  // Spokes that are live on-chain but that the API does not name still render
  // as their raw id — surface them instead of leaving the gap silent.
  const named = new Set(discovered.map((s) => `${s.chainId}:${s.spoke}`));
  const unnamed: string[] = [];
  for (const chainId of Object.keys(spokesJson ?? {})) {
    for (const [spoke, entry] of Object.entries(spokesJson[chainId] ?? {})) {
      if (isPlaceholderSpokeLabel(entry?.label) && !named.has(`${chainId}:${spoke}`)) {
        unnamed.push(`${chainId}:${spoke}`);
      }
    }
  }
  if (unnamed.length > 0) {
    console.log(
      `\n${unnamed.length} discovered spoke(s) have no name from the API and stay unlabelled.`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
