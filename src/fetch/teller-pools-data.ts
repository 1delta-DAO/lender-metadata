import { DataUpdater } from "../types.js";
import { mergeData, mergeData as deepMergeData, sortRecord } from "../utils.js";
import { fetchTellerPoolsOnChain, type TellerPoolRow } from "./teller/pools.js";

const poolsFile = "./data/teller-pools.json";
const labelsFile = "./data/lender-labels.json";

/** Synthesized per-pool lender enum key, mirroring the margin-fetcher's key. */
export const tellerLenderKey = (pool: string): string =>
  `TELLER_${pool.replace(/^0x/i, "").toUpperCase()}`;

/**
 * Display labels for every pool, keyed by the synthesized lender enum.
 *
 * The frontend resolves market names from `lender-labels.json`, so a pool with
 * no entry renders as the raw `TELLER_E6AB9D0C…` key. Built here rather than in
 * a separate manual pass so the nightly job names new pools in the same run
 * that discovers them — a standalone script only runs when someone remembers,
 * which is how every Term market ended up nameless.
 *
 * Symbols come from the on-chain read above, never the Teller middleware API,
 * which has been observed to report the wrong token for a pool.
 */
export function buildTellerLabels(pools: Record<string, TellerPoolRow[]>): {
  names: Record<string, string>;
  shortNames: Record<string, string>;
} {
  const names: Record<string, string> = { TELLER: "Teller" };
  const shortNames: Record<string, string> = { TELLER: "Teller" };
  for (const rows of Object.values(pools ?? {})) {
    for (const p of rows ?? []) {
      if (!p?.pool) continue;
      const ps = p.principalSymbol ?? "?";
      const cs = p.collateralSymbol ?? "?";
      const key = tellerLenderKey(p.pool);
      names[key] = p.name ?? `Teller ${ps} / ${cs}`;
      shortNames[key] = `${ps}/${cs}`;
    }
  }
  return { names: sortRecord(names), shortNames: sortRecord(shortNames) };
}

/**
 * Rebuild data/teller-pools.json with token metadata read from each pool
 * ON-CHAIN (the Teller middleware API's token addresses/decimals are
 * unreliable). Pool addresses come from the existing file; tokens, decimals,
 * symbols, marketId and maxLoanDuration are overwritten with on-chain truth.
 * Also emits the per-pool display labels (see `buildTellerLabels`).
 */
export class TellerPoolsUpdater implements DataUpdater {
  name = "Teller Pools";

  async fetchData(): Promise<Partial<any>> {
    const data = await fetchTellerPoolsOnChain();
    return { [poolsFile]: data, [labelsFile]: buildTellerLabels(data as any) };
  }

  /**
   * Pools: replace wholesale — stale token metadata would be misleading.
   * Labels: deep-merge. The file is shared with every other lender family, so
   * replacing it would wipe Morpho/Silo/Term/etc; and a pool that drops out of
   * the roster keeps its name so a user still holding a loan can read it.
   */
  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    if (fileKey === labelsFile) return deepMergeData(oldData ?? {}, data ?? {});
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
