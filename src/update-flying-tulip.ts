// ============================================================================
// Write the Flying Tulip asset roster to data/flying-tulip-assets.json and its
// display labels to data/lender-labels.json.
//
// Flying Tulip is CROSS-MARGIN — one `PositionsManager` per chain, one global
// health check — so the artifact is an ASSET roster under a single bare
// `FLYING_TULIP` key, not a market list, and the labels are two entries rather
// than a per-market fan-out.
//
// Discovery is a full-history `AssetSet` log scan on the ConfigRegistry; see
// `fetch/flying-tulip/flyingTulip.ts` for why that beats the hand-curated
// allowlist the original assessment called for, and for the endpoint choices
// that make the scan actually return data.
//
// Usage: `tsx src/update-flying-tulip.ts`  (npm run update:flying-tulip)
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import {
  fetchFlyingTulipRoster,
  buildFlyingTulipLabels,
} from "./fetch/flying-tulip/flyingTulip.js";

const ROSTER_FILE = "./data/flying-tulip-assets.json";
const LABELS_FILE = "./data/lender-labels.json";

async function main() {
  const roster = await fetchFlyingTulipRoster();

  const chains = Object.keys(roster);
  const total = chains.reduce((n, c) => n + roster[c].assets.length, 0);
  if (total === 0) {
    console.error("Flying Tulip: roster is empty — refusing to write.");
    process.exit(1);
  }

  const rosterRes = await writeTextIfChanged(
    ROSTER_FILE,
    JSON.stringify({ FLYING_TULIP: roster }, null, 2) + "\n",
  );

  const built = buildFlyingTulipLabels();
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
    `Flying Tulip: ${total} asset(s) across ${chains.length} chain(s) (${rosterRes}); labels (${labelRes})`,
  );
  for (const c of chains) {
    const ch = roster[c];
    console.log(
      `  chain ${c}: hfSafe=${ch.marginHfSafeBps} hfTarget=${ch.marginHfTargetBps} minEquityUSDWad=${ch.marginMinEquityUSDWad}`,
    );
    for (const a of ch.assets) {
      const flags = [
        a.enabled ? "enabled" : "DISABLED",
        a.borrowable ? "borrowable" : "collateral-only",
        a.collateral ? "collateral" : "not-collateral",
        a.priceable ? "" : "UNPRICED",
        a.depositPaused ? "depositPaused" : "",
        a.borrowPaused ? "borrowPaused" : "",
        a.withdrawPaused ? "withdrawPaused" : "",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(
        `    ${a.symbol.padEnd(8)} mm=${String(a.mmBps).padStart(4)}  ${flags}`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
