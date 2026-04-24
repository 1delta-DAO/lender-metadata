// ============================================================================
// Populate the LISTA_DAO section of config/morpho-type-markets.json from the
// Lista moolah API. Append-only: existing market ids are never removed.
// Run as a separate job because the API is access-restricted.
//
// Also:
//   - cross-references the new markets' loan/collateral token addresses
//     against the 1delta-DAO token list and logs any missing assets.
//   - appends lender labels (names + shortNames) for the new markets to
//     data/lender-labels.json, matching the format produced by the main
//     MorphoBlueUpdater.
// ============================================================================

import { zeroAddress } from "viem";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import {
  fetchListaMarkets,
  resolveListaMarketAssets,
  type ListaMarketAssets,
  type ListaMarketInfo,
} from "./fetch/morpho/fetchListaApi.js";

const MARKETS_FILE = "./config/morpho-type-markets.json";
const POOLS_FILE = "./config/morpho-pools.json";
const LABELS_FILE = "./data/lender-labels.json";
const MISSING_ASSETS_LOG = "./data/lista-missing-assets.log";
const FORK = "LISTA_DAO";

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

/** Lista API returns lltv as a decimal fraction (e.g. "0.965..."). */
function lltvDecimalToBps(lltv: string): string {
  const n = Number(lltv);
  if (!Number.isFinite(n)) return "0";
  return Math.round(n * 100).toString();
}

function enumName(marketId: string): string {
  return `${FORK}_${marketId.slice(2).toUpperCase()}`;
}

async function main(): Promise<void> {
  const markets = await fetchListaMarkets();
  const totalFetched = Object.values(markets).reduce(
    (acc, list) => acc + list.length,
    0,
  );
  console.log(
    `Fetched ${totalFetched} Lista markets across ${Object.keys(markets).length} chains`,
  );

  const existing = readJsonFile(MARKETS_FILE);
  const pools = readJsonFile(POOLS_FILE);
  if (!existing[FORK]) existing[FORK] = {};

  let added = 0;
  const newIdsByChain: Record<string, ListaMarketInfo[]> = {};
  for (const [chainId, infos] of Object.entries(markets)) {
    const current: string[] = existing[FORK][chainId] ?? [];
    const set = new Set(current);
    const fresh: ListaMarketInfo[] = [];
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
  console.log(`Added ${added} new Lista market ids; file ${writeResult}.`);

  // ---- labels -----------------------------------------------------------
  // Run over *all* API-returned markets, not just newly added ids — the labels
  // file may be incomplete even when the market ids file is already in sync.
  const labels = readJsonFile(LABELS_FILE);
  if (!labels.names) labels.names = {};
  if (!labels.shortNames) labels.shortNames = {};

  let labelsAdded = 0;
  const unlabeledByChain: Record<string, ListaMarketInfo[]> = {};
  for (const [chainId, infos] of Object.entries(markets)) {
    for (const info of infos) {
      const { collateralSymbol, loanSymbol, lltv, id } = info;
      if (!collateralSymbol || !loanSymbol) continue;
      const key = enumName(id);
      const wasUnlabeled = !(key in labels.names);
      const bps = lltvDecimalToBps(lltv);
      const longName = `Lista ${collateralSymbol}-${loanSymbol} ${bps}`;
      const shortName = `LD ${collateralSymbol}-${loanSymbol} ${bps}`;
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
      `Added/updated ${labelsAdded} Lista labels; file ${labelsResult}.`,
    );
  } else {
    console.log("No new Lista labels to add.");
  }

  // ---- missing-asset check ---------------------------------------------
  const missing: MissingAssetEntry[] = [];
  // Check assets for markets we've never labeled before (newly discovered) —
  // falls back to the ids-file delta on a first run.
  const assetCheckTargets: Record<string, ListaMarketInfo[]> =
    Object.keys(unlabeledByChain).length > 0 ? unlabeledByChain : newIdsByChain;
  for (const [chainId, infos] of Object.entries(assetCheckTargets)) {
    const poolAddress: string | undefined = pools?.[FORK]?.[chainId];
    if (!poolAddress) {
      console.warn(`No ${FORK} pool configured for chain ${chainId}; skipping asset check.`);
      continue;
    }

    const ids = infos.map((i) => i.id);
    let assets: ListaMarketAssets[];
    try {
      assets = await resolveListaMarketAssets(chainId, poolAddress, ids);
    } catch (err) {
      console.warn(`Asset resolution failed for chain ${chainId}:`, err);
      continue;
    }

    let tokenSet: Set<string>;
    try {
      tokenSet = await loadTokenList(chainId);
    } catch (err) {
      console.warn(`Token list fetch failed for chain ${chainId}:`, err);
      continue;
    }

    for (const a of assets) {
      const missingTokens: string[] = [];
      const check = (t: string) => {
        if (!t || t === zeroAddress) return;
        if (!tokenSet.has(t)) missingTokens.push(t);
      };
      check(a.loanToken);
      check(a.collateralToken);
      if (missingTokens.length > 0) {
        missing.push({
          chainId,
          marketId: a.marketId,
          missing: Array.from(new Set(missingTokens)),
          loanToken: a.loanToken,
          collateralToken: a.collateralToken,
        });
      }
    }
  }

  if (missing.length === 0) {
    console.log("No missing assets in the 1delta-DAO token lists.");
  } else {
    const lines: string[] = [
      `# Lista market assets missing from 1delta-DAO token lists`,
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
