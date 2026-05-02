// ============================================================================
// Populate the MORPHO_BLUE section of config/morpho-type-markets.json with the
// Mystic Finance market ids on Flare / Plume / Citrea. Append-only: existing
// market ids are never removed.
//
// Also:
//   - appends lender labels (names + shortNames) for the new markets to
//     data/lender-labels.json, matching the format produced by
//     MorphoBlueUpdater.
//   - cross-references the new markets' loan/collateral token addresses
//     against the 1delta-DAO token list and logs any missing assets.
//
// The main MorphoBlueUpdater already covers these chains via the Mystic API,
// so this script is mostly a redundancy check / fast path that doesn't need
// the on-chain RPCs the main job pulls in.
// ============================================================================

import { zeroAddress } from "viem";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import {
  fetchAllMysticMarkets,
  type MysticMarketInfo,
} from "./fetch/morpho/fetchMysticApi.js";

const MARKETS_FILE = "./config/morpho-type-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const MISSING_ASSETS_LOG = "./data/mystic-missing-assets.log";
const FORK = "MORPHO_BLUE";

const tokenListUrl = (chainId: string) =>
  `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;

async function loadTokenList(chainId: string): Promise<Set<string>> {
  const res = await fetch(tokenListUrl(chainId));
  if (!res.ok) {
    throw new Error(
      `Token list fetch failed for chain ${chainId}: ${res.status}`,
    );
  }
  const body = (await res.json()) as { list: Record<string, unknown> };
  return new Set(Object.keys(body.list).map((a) => a.toLowerCase()));
}

type MissingAssetEntry = {
  chainId: string;
  marketId: string;
  missing: string[];
  loanToken: string;
  collateralToken: string;
};

/** Mystic returns lltv as a decimal fraction (e.g. 0.625). */
function lltvDecimalToBps(lltv: number): string {
  if (!Number.isFinite(lltv)) return "0";
  return Math.round(lltv * 100).toString();
}

function enumName(marketId: string): string {
  return `${FORK}_${marketId.slice(2).toUpperCase()}`;
}

async function main(): Promise<void> {
  const markets = await fetchAllMysticMarkets();
  const totalFetched = Object.values(markets).reduce(
    (acc, list) => acc + list.length,
    0,
  );
  console.log(
    `Fetched ${totalFetched} Mystic markets across ${Object.keys(markets).length} chains`,
  );

  const existing = readJsonFile(MARKETS_FILE);
  if (!existing[FORK]) existing[FORK] = {};

  let added = 0;
  const newIdsByChain: Record<string, MysticMarketInfo[]> = {};
  for (const [chainId, infos] of Object.entries(markets)) {
    if (infos.length === 0) continue;
    const current: string[] = existing[FORK][chainId] ?? [];
    const set = new Set(current);
    const fresh: MysticMarketInfo[] = [];
    for (const info of infos) {
      if (!set.has(info.id)) {
        set.add(info.id);
        fresh.push(info);
        added++;
      }
    }
    existing[FORK][chainId] = Array.from(set).sort();
    if (fresh.length > 0) newIdsByChain[chainId] = fresh;
  }

  const writeResult = await writeTextIfChanged(
    MARKETS_FILE,
    JSON.stringify(existing, null, 2) + "\n",
  );
  console.log(`Added ${added} new Mystic market ids; file ${writeResult}.`);

  // ---- labels -----------------------------------------------------------
  // Run over *all* API-returned markets, not just newly added ids — the labels
  // file may be incomplete even when the market ids file is already in sync.
  const labels = readJsonFile(LABELS_FILE);
  if (!labels.names) labels.names = {};
  if (!labels.shortNames) labels.shortNames = {};

  let labelsAdded = 0;
  const unlabeledByChain: Record<string, MysticMarketInfo[]> = {};
  for (const [chainId, infos] of Object.entries(markets)) {
    for (const info of infos) {
      const { collateralSymbol, loanSymbol, lltv, id } = info;
      if (!collateralSymbol || !loanSymbol) continue;
      const key = enumName(id);
      const wasUnlabeled = !(key in labels.names);
      const bps = lltvDecimalToBps(lltv);
      const longName = `Morpho ${collateralSymbol}-${loanSymbol} ${bps}`;
      const shortName = `MB ${collateralSymbol}-${loanSymbol} ${bps}`;
      if (labels.names[key] !== longName) {
        labels.names[key] = longName;
        if (wasUnlabeled) labelsAdded++;
      }
      if (labels.shortNames[key] !== shortName) {
        labels.shortNames[key] = shortName;
      }
      if (wasUnlabeled) {
        if (!unlabeledByChain[chainId]) unlabeledByChain[chainId] = [];
        unlabeledByChain[chainId].push(info);
      }
    }
  }

  if (labelsAdded > 0) {
    labels.names = Object.fromEntries(
      Object.entries(labels.names).sort(([a], [b]) => a.localeCompare(b)),
    );
    labels.shortNames = Object.fromEntries(
      Object.entries(labels.shortNames).sort(([a], [b]) => a.localeCompare(b)),
    );
    const labelsResult = await writeTextIfChanged(
      LABELS_FILE,
      JSON.stringify(labels, null, 2) + "\n",
    );
    console.log(
      `Added/updated ${labelsAdded} Mystic labels; file ${labelsResult}.`,
    );
  } else {
    console.log("No new Mystic labels to add.");
  }

  // ---- missing-asset check ---------------------------------------------
  const missing: MissingAssetEntry[] = [];
  const assetCheckTargets: Record<string, MysticMarketInfo[]> =
    Object.keys(unlabeledByChain).length > 0 ? unlabeledByChain : newIdsByChain;
  for (const [chainId, infos] of Object.entries(assetCheckTargets)) {
    let tokenSet: Set<string>;
    try {
      tokenSet = await loadTokenList(chainId);
    } catch (err) {
      console.warn(`Token list fetch failed for chain ${chainId}:`, err);
      continue;
    }

    for (const info of infos) {
      const missingTokens: string[] = [];
      const check = (t: string) => {
        if (!t || t === zeroAddress) return;
        if (!tokenSet.has(t.toLowerCase())) missingTokens.push(t);
      };
      check(info.loanToken);
      check(info.collateralToken);
      if (missingTokens.length > 0) {
        missing.push({
          chainId,
          marketId: info.id,
          missing: Array.from(new Set(missingTokens)),
          loanToken: info.loanToken,
          collateralToken: info.collateralToken,
        });
      }
    }
  }

  if (missing.length === 0) {
    console.log("No missing assets in the 1delta-DAO token lists.");
  } else {
    const lines: string[] = [
      `# Mystic market assets missing from 1delta-DAO token lists`,
      `# generated: ${new Date().toISOString()}`,
      `# entries: ${missing.length}`,
      ``,
    ];
    for (const m of missing) {
      lines.push(
        `chain=${m.chainId} market=${m.marketId} loan=${m.loanToken} collateral=${m.collateralToken} missing=${m.missing.join(",")}`,
      );
    }
    await writeTextIfChanged(MISSING_ASSETS_LOG, lines.join("\n") + "\n");
    console.log(
      `Logged ${missing.length} markets with missing assets to ${MISSING_ASSETS_LOG}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
