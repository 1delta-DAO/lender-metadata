// ============================================================================
// Write the PROTOCOL each lender family belongs to into
// data/lender-labels.json, as a third map alongside `names` / `shortNames`.
//
// `names` is the versioned label a row renders — "Aave V3", "Silo V3". The
// protocol is what a user GROUPS by, and the two are not the same: Aave V2, V3
// and V4 are one protocol; Silo V2 and V3 are one protocol; the Euler Earn
// vaults and the Euler V2 markets are one protocol.
//
// Without it, six protocols sat in separate buckets on the earn surface:
//
//   Morpho Blue(2055) + Morpho(87)        Euler V2(530) + Euler(46)
//   Silo V2(170) + Silo V3(74) + Silo(4)  Gearbox V3(167) + Gearbox(3)
//   Aave V3(78) + Aave V4(69) + Aave(5)   Compound V3(73) + Compound V2(19)
//
// so filtering by "Euler" returned the 46 Earn vaults and none of the 530
// lending markets — they were under a bucket a user has no reason to open.
// margin-fetcher currently carries this as a hand table (`PROTOCOL_ALIASES`),
// which is the same "store a bad name and repair it downstream" shape this file
// exists to end. This is the source; that table becomes the fallback.
//
// Only the families whose protocol DIFFERS from their label need an entry —
// everything absent means "the label is already the protocol", which is true
// for the overwhelming majority.
//
// Usage: `tsx src/update-protocol-labels.ts`
// ============================================================================

import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";

const LABELS_FILE = "./data/lender-labels.json";

/**
 * Family key -> protocol name.
 *
 * Keyed by the FAMILY, not by the per-market key: `MORPHO_BLUE_<32-byte id>`
 * inherits from `MORPHO_BLUE`, so one entry covers 2,000 markets.
 *
 * `MORPHO_MIDNIGHT` is deliberately absent. It is a fixed-rate order book, not
 * a Blue deployment, and folding it into "Morpho" would group two unrelated
 * products under one filter.
 */
const PROTOCOL_BY_FAMILY: Record<string, string> = {
  MORPHO_BLUE: "Morpho",
  EULER_V2: "Euler",
  SILO_V2: "Silo",
  SILO_V3: "Silo",
  GEARBOX_V3: "Gearbox",
  AAVE_V2: "Aave",
  AAVE_V3: "Aave",
  AAVE_V4: "Aave",
  COMPOUND_V2: "Compound",
  COMPOUND_V3: "Compound",
  LIQUITY_V2: "Liquity",
  RADIANT_V2: "Radiant",
  LAYERBANK_V3: "LayerBank",
  // Compound V2 forks that run ISOLATED POOLS as separate lender keys. Each pool
  // is its own `Lender` member, so prefix inheritance does not reach it from a
  // bare family entry — without these, "Venus BNB", "Venus BTC", "Venus DeFi" …
  // each become their own protocol bucket and filtering by "Venus" returns the
  // core pool alone. Same shape as the Euler/Silo split this file exists to fix.
  VENUS: "Venus",
  ENCLABS: "Enclabs",
  KINETIC: "Kinetic",
  TECTONIC: "Tectonic",
  BENQI: "Benqi",
  BASTION: "Bastion",
  KEOM: "Keom Protocol",
};

/**
 * Longest family prefix wins, so `AAVE_V3_PRIME` resolves through `AAVE_V3`
 * rather than stopping at a shorter, wrong match. The `_` boundary is what
 * keeps `TERMMAX_*` from ever resolving through `TERM_FINANCE`.
 */
function protocolFor(lenderKey: string): string | undefined {
  const key = lenderKey.toUpperCase();
  let best: string | undefined;
  for (const family of Object.keys(PROTOCOL_BY_FAMILY)) {
    if (key !== family && !key.startsWith(`${family}_`)) continue;
    if (!best || family.length > best.length) best = family;
  }
  return best ? PROTOCOL_BY_FAMILY[best] : undefined;
}

async function main() {
  const labels = (await readJsonFile(LABELS_FILE)) as {
    names?: Record<string, string>;
    shortNames?: Record<string, string>;
    protocols?: Record<string, string>;
  };
  const names = labels.names ?? {};

  const protocols: Record<string, string> = {};
  for (const lenderKey of Object.keys(names)) {
    const protocol = protocolFor(lenderKey);
    // Absent means "the label is already the protocol". Writing it out for
    // every key would triple the file to restate what `names` already says.
    if (protocol) protocols[lenderKey] = protocol;
  }

  const next = {
    ...labels,
    names: sortRecord(names),
    shortNames: sortRecord(labels.shortNames ?? {}),
    protocols: sortRecord(protocols),
  };

  const changed = await writeTextIfChanged(
    LABELS_FILE,
    `${JSON.stringify(next, null, 2)}\n`,
  );
  const families = new Set(Object.values(protocols));
  console.log(
    `protocol labels: ${Object.keys(protocols).length} keys -> ` +
      `${families.size} protocols (${[...families].sort().join(", ")})` +
      `${changed ? "" : " — unchanged"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
