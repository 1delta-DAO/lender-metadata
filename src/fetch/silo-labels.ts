// Shared label builder for Silo v2 / v3. Emits one entry per silo *side*
// keyed as `SILO_V{N}_<UPPER_SILO_ADDRESS>`, matching the per-side reserve
// uid convention used downstream. The pair name is `<thisSym>/<otherSym>`
// from this side's perspective.
//
// Both the v2 and v3 updaters call `buildAllSiloLabels` with the raw
// `GqlSilo[]` from `fetchAllSilos()` and emit the *complete* v2+v3 label
// set. This is intentional: both updaters write to the same
// `lender-labels.json` file, and the data-manager loads each updater's
// existing-on-disk state independently before merging — so a per-version
// label set would be clobbered when the second updater writes. Emitting
// the full set from both makes the merge order-independent.

import type { GqlSilo } from "./silo-shared/graphql.js";

export type LabelsOut = {
  names: Record<string, string>;
  shortNames: Record<string, string>;
};

type EntryLike = {
  siloConfig: string;
  silo0: { symbol?: string };
  silo1: { symbol?: string };
};

/**
 * Build `{ names, shortNames }` for every silo pair in `markets`, keyed
 * by siloConfig address.
 */
export function buildSiloLabels(
  markets: { [chainId: string]: EntryLike[] },
  version: "V2" | "V3",
  longPrefix: string,
  shortPrefix: string,
): LabelsOut {
  const names: Record<string, string> = {};
  const shortNames: Record<string, string> = {};

  for (const pairs of Object.values(markets)) {
    for (const pair of pairs) {
      const key = `SILO_${version}_${pair.siloConfig.replace(/^0x/, "").toUpperCase()}`;
      const sym0 = pair.silo0?.symbol || "?";
      const sym1 = pair.silo1?.symbol || "?";

      names[key] = `${longPrefix} ${sym0}/${sym1}`;
      shortNames[key] = `${shortPrefix} ${sym0}/${sym1}`;
    }
  }

  return { names, shortNames };
}

const PREFIXES = {
  v2: { long: "Silo V2", short: "S2", version: "V2" as const },
  v3: { long: "Silo V3", short: "S3", version: "V3" as const },
};

/**
 * Build labels for every silo in `rawSilos` regardless of version. Both
 * updaters call this with the same `fetchAllSilos()` output so the
 * resulting `lender-labels.json` is identical no matter which updater
 * writes last.
 *
 * Labels are keyed by **siloConfig** (the pair address), not individual
 * silo vault addresses: `SILO_V{N}_<UPPER_CONFIG_ADDRESS>`.
 */
export function buildAllSiloLabels(rawSilos: GqlSilo[]): LabelsOut {
  const names: Record<string, string> = {};
  const shortNames: Record<string, string> = {};

  for (const s of rawSilos) {
    const v = s.protocol?.protocolVersion;
    if (v !== "v2" && v !== "v3") continue;
    if (!s.market1 || !s.market2) continue;

    const cfg = PREFIXES[v];
    const key = `SILO_${cfg.version}_${s.configAddress.replace(/^0x/, "").toUpperCase()}`;

    // Order sides by `index` so the slash-separated name is deterministic
    // (silo0 first, silo1 second).
    const byIndex: { [k: number]: string } = {};
    for (const m of [s.market1, s.market2]) {
      byIndex[m.index] = m.inputToken?.symbol || "?";
    }
    const sym0 = byIndex[0] ?? "?";
    const sym1 = byIndex[1] ?? "?";

    names[key] = `${cfg.long} ${sym0}/${sym1}`;
    shortNames[key] = `${cfg.short} ${sym0}/${sym1}`;
  }

  return { names, shortNames };
}
