import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { fetchMorphoOracleData } from "./morpho/fetchMorphoOracleData.js";
import type { MorphoOraclesDataMap } from "./morpho/fetchMorphoOracleData.js";

const oraclesDataFile = "./data/morpho-oracles-data.json";

/**
 * Fields that carry READ information: each is populated from an on-chain call
 * or derived from one, and each maps a failed call to `null` / `"UNKNOWN"`.
 * Identity fields (oracle, assets, irm, lltv, fork) are excluded — they come
 * from the market roster, not from a read that can fail.
 */
const READ_FIELDS = [
  "baseFeed1",
  "baseFeed1Description",
  "baseFeed2",
  "baseFeed2Description",
  "quoteFeed1",
  "quoteFeed1Description",
  "quoteFeed2",
  "quoteFeed2Description",
  "baseVault",
  "baseVaultDescription",
  "baseVaultUnderlying",
  "quoteVault",
  "quoteVaultDescription",
  "quoteVaultUnderlying",
  "underlyingOracle",
  "priceDescription",
  "correctOracle",
  "denominatorMatch",
  "fixedRate",
] as const;

let hollowRejects = 0;

const isKnown = (v: unknown) =>
  v !== null && v !== undefined && v !== "" && v !== "UNKNOWN";

/**
 * Is `next` a strictly WORSE answer than `prev` — i.e. does it blank a field
 * `prev` had, while adding nothing of its own?
 *
 * This is the guard the market-level replace was missing, and it is the one
 * that generalises. `fetchMorphoOracleData` builds an entry from SEVERAL
 * independent multicall batches (oracle config, `currentOracle()` wrappers,
 * feed `description()`s, vault symbols), every one of them issued with
 * `allowFailure: true`, and every one of them mapping a failure to `null`.
 * Guarding a single batch at the producer does not help: on a rate-limited run
 * viem marks a WHOLE CHUNK failed on one 429 (see the `viem-multicall-silent-
 * failure` note), so whichever batch gets throttled writes its share of nulls
 * and the entry is replaced wholesale by a confident-looking husk. Measured on
 * two separate runs, 2026-09-07: 525 of 563 Ethereum entries degraded, 2,430
 * then 2,592 fields blanked — and BOTH runs exited 0 reporting success.
 *
 * The rule that holds regardless of which batch failed: a refresh may add
 * information or change it, but it may never DELETE it. An oracle's config is
 * constructor-set and its feeds' descriptions are static, so a field going
 * populated -> empty is a failed read essentially every time; where a value
 * genuinely changes, `next` still carries a value and replaces wholesale, so
 * the "no stale fields linger" property the market-level replace was written
 * for is preserved.
 */
function isHollowerThan(next: any, prev: any): boolean {
  if (!prev || !next) return false;
  let lost = 0;
  let gained = 0;
  for (const f of READ_FIELDS) {
    const had = isKnown(prev[f]);
    const has = isKnown(next[f]);
    if (had && !has) lost++;
    else if (!had && has) gained++;
  }
  // A run that only ever ADDS is a healthy refresh, even a partial one. Any
  // net loss of known fields is treated as an unreadable run for this entry.
  if (lost > 0 && gained === 0) {
    hollowRejects++;
    return true;
  }
  return false;
}

export class MorphoOracleDataUpdater implements DataUpdater {
  name = "Morpho Oracle Data";

  async fetchData(): Promise<Partial<any>> {
    const data = await fetchMorphoOracleData();
    return { [oraclesDataFile]: data };
  }

  /**
   * Market-level union: never lose entries.
   *
   * A freshly fetched market fully overrides its previous entry, and new
   * markets / chains are added — but any market or chain that is ABSENT from
   * this run is retained from the existing file. A transient per-chain or
   * per-fork fetch failure (which surfaces as a missing chain/market rather
   * than a thrown error, see fetchMorphoOracleData) must never wipe
   * previously-good data, so we only override and add, never delete.
   *
   * This is a *market-level* replace, not a field-level deep-merge: a
   * re-fetched market object replaces the old one wholesale, so stale fields
   * inside a re-fetched market never linger. (Field-level deep-merge was
   * avoided for exactly that reason.)
   *
   * Never-delete is unconditionally correct here: Morpho markets are immutable
   * and append-only on-chain — once created, a market cannot be removed. The
   * market set therefore only ever grows, so a market missing from a given run
   * is always a fetch gap, never a real deletion. There is no stale entry to
   * prune, only fetch coverage to protect.
   */
  mergeData(oldData: any, data: any, _fileKey: string): Partial<any> {
    hollowRejects = 0;
    const prev = (oldData ?? {}) as MorphoOraclesDataMap;
    const next = (data ?? {}) as MorphoOraclesDataMap;

    const out: MorphoOraclesDataMap = {};
    const chains = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const chain of chains) {
      const prevChain = prev[chain] ?? {};
      const nextChain = next[chain] ?? {};
      const marketIds = new Set([
        ...Object.keys(prevChain),
        ...Object.keys(nextChain),
      ]);
      const mergedChain: MorphoOraclesDataMap[string] = {};
      for (const id of marketIds) {
        if (!(id in nextChain)) {
          mergedChain[id] = prevChain[id];
          continue;
        }
        // Fresh entry overrides wholesale — unless it is HOLLOWER than the one
        // it would replace, which means the run could not read what the file
        // already knows. See `isHollowerThan`.
        mergedChain[id] = isHollowerThan(nextChain[id], prevChain[id])
          ? prevChain[id]
          : nextChain[id];
      }
      out[chain] = mergedChain;
    }

    if (hollowRejects > 0) {
      console.warn(
        `[morpho-oracles-data] kept ${hollowRejects} existing entries whose refresh came back hollower — the run could not read what the file already knows (rate limiting is the usual cause)`
      );
    }

    // Reuse mergeData purely to get stable, sorted key ordering for clean diffs.
    return mergeData(out, {});
  }

  defaults = {};
}
