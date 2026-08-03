// ============================================================================
// Backfill display labels for Term Finance repos into data/lender-labels.json.
//
// The nightly `update:dataset` job already writes these — `TermMarketsUpdater`
// emits labels in the same run that discovers the repos, so new maturities are
// never published nameless. This script is the standalone backfill for when
// `data/term-finance-markets.json` was updated out of band (a hand edit, a
// cherry-picked file) and you want the labels caught up without re-fetching the
// subgraph. It reads the published markets file and nothing else.
//
// Label shape (maturity included, because a pair has one repo per maturity and
// the truncated raw keys are otherwise indistinguishable):
//   names[TERM_FINANCE_<id>]      = "Term USDC / wstETH — 2026-09-03"
//   shortNames[TERM_FINANCE_<id>] = "TF USDC/wstETH 2026-09-03"
//
// Additive: labels for repos no longer in the markets file are left alone, so a
// matured repo a user still holds a position in keeps its name.
//
// Usage: `tsx src/update-term-labels.ts`  (npm run update:term-labels)
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
import { buildTermLabels, type TermMarketRow } from "./fetch/term/term.js";

const LABELS_FILE = "./data/lender-labels.json";
const MARKETS_FILE = "./data/term-finance-markets.json";

async function main() {
  const markets = (readJsonFile(MARKETS_FILE) ?? {}) as Record<
    string,
    TermMarketRow[]
  >;
  const built = buildTermLabels(markets);

  const labels = readJsonFile(LABELS_FILE) ?? {};
  labels.names ??= {};
  labels.shortNames ??= {};
  Object.assign(labels.names, built.names);
  Object.assign(labels.shortNames, built.shortNames);
  labels.names = sortRecord(labels.names);
  labels.shortNames = sortRecord(labels.shortNames);

  const res = await writeTextIfChanged(
    LABELS_FILE,
    JSON.stringify(labels, null, 2) + "\n",
  );
  // −1 for the bare TERM_FINANCE base key.
  console.log(
    `Term labels: ${Object.keys(built.names).length - 1} repo label(s) + base (${res})`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
