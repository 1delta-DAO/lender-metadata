import { describe, it, expect } from "vitest";
import { mergeOracleDataMaps } from "./morpho.js";
import { MorphoOracleDataUpdater } from "../morpho-oracle-data.js";

// Both regressions here cost real data on 2026-09-07 and neither raised an
// error: the jobs exited 0 and the files looked internally consistent
// afterwards. They are the two ways a "refresh" can destroy what it refreshes.

const row = (oracle: string, loan: string, coll: string) => ({
  oracle,
  loanAsset: loan,
  collateralAsset: coll,
  loanAssetDecimals: 6,
  collateralAssetDecimals: 18,
});

describe("mergeOracleDataMaps — keyed by the (oracle, loan, collateral) TRIPLET", () => {
  const LOAN = "0xaaaa";
  const COLL = "0xbbbb";

  it("keeps two markets that share a pair but use different oracles", () => {
    const a = row("0x1111", LOAN, COLL);
    const b = row("0x2222", LOAN, COLL);
    const merged = mergeOracleDataMaps(
      { "1": { MORPHO_BLUE: [a] } },
      { "1": { MORPHO_BLUE: [b] } },
    );
    const out = merged["1"].MORPHO_BLUE;
    // Keyed on the pair alone this returned ONE row, silently dropping the
    // other — 37 such rows on Ethereum alone.
    expect(out).toHaveLength(2);
    expect(out.map((r: any) => r.oracle).sort()).toEqual(["0x1111", "0x2222"]);
  });

  it("still lets a re-fetched row replace its own previous version", () => {
    const old = { ...row("0x1111", LOAN, COLL), collateralAssetDecimals: 8 };
    const fresh = row("0x1111", LOAN, COLL);
    const merged = mergeOracleDataMaps(
      { "1": { MORPHO_BLUE: [old] } },
      { "1": { MORPHO_BLUE: [fresh] } },
    );
    expect(merged["1"].MORPHO_BLUE).toHaveLength(1);
    expect(merged["1"].MORPHO_BLUE[0].collateralAssetDecimals).toBe(18);
  });

  it("matches rows case-insensitively rather than duplicating them", () => {
    const merged = mergeOracleDataMaps(
      { "1": { MORPHO_BLUE: [row("0xAbCd", "0xEeEe", "0xFfFf")] } },
      { "1": { MORPHO_BLUE: [row("0xabcd", "0xeeee", "0xffff")] } },
    );
    expect(merged["1"].MORPHO_BLUE).toHaveLength(1);
  });

  it("never drops a chain or fork that only the old map had", () => {
    const merged = mergeOracleDataMaps(
      { "14": { MORPHO_BLUE: [row("0x1111", LOAN, COLL)] } },
      { "1": { MORPHO_BLUE: [row("0x2222", LOAN, COLL)] } },
    );
    expect(merged["14"].MORPHO_BLUE).toHaveLength(1);
    expect(merged["1"].MORPHO_BLUE).toHaveLength(1);
  });
});

describe("MorphoOracleDataUpdater.mergeData — a refresh may not DELETE information", () => {
  const updater = new MorphoOracleDataUpdater();
  const full = {
    oracle: "0xoracle",
    loanAsset: "0xloan",
    collateralAsset: "0xcoll",
    baseFeed1: "0xfeed",
    baseFeed1Description: "PST / USDC",
    priceDescription: "PST / USDC",
    correctOracle: true,
    denominatorMatch: true,
  };
  // What a rate-limited run produces: the identity survives, every read is null.
  const hollow = {
    ...full,
    baseFeed1: null,
    baseFeed1Description: null,
    priceDescription: "UNKNOWN",
    correctOracle: null,
    denominatorMatch: null,
  };

  it("rejects a hollow refresh and keeps the populated entry", () => {
    const out: any = updater.mergeData(
      { "1": { m1: full } },
      { "1": { m1: hollow } },
      "any",
    );
    expect(out["1"].m1.baseFeed1).toBe("0xfeed");
    expect(out["1"].m1.priceDescription).toBe("PST / USDC");
    expect(out["1"].m1.correctOracle).toBe(true);
  });

  it("accepts a refresh that CHANGES a value", () => {
    const changed = { ...full, baseFeed1Description: "PST / USDT" };
    const out: any = updater.mergeData(
      { "1": { m1: full } },
      { "1": { m1: changed } },
      "any",
    );
    expect(out["1"].m1.baseFeed1Description).toBe("PST / USDT");
  });

  it("accepts a partial refresh that only ADDS fields", () => {
    const sparse = { ...full, baseFeed1Description: null };
    const filled = { ...full };
    const out: any = updater.mergeData(
      { "1": { m1: sparse } },
      { "1": { m1: filled } },
      "any",
    );
    expect(out["1"].m1.baseFeed1Description).toBe("PST / USDC");
  });

  it("still retains an entry the run did not return at all", () => {
    const out: any = updater.mergeData({ "1": { m1: full } }, { "1": {} }, "any");
    expect(out["1"].m1.baseFeed1).toBe("0xfeed");
  });

  it("still adds brand-new entries and chains", () => {
    const out: any = updater.mergeData(
      { "1": { m1: full } },
      { "1": { m2: full }, "14": { m3: full } },
      "any",
    );
    expect(Object.keys(out["1"]).sort()).toEqual(["m1", "m2"]);
    expect(out["14"].m3).toBeDefined();
  });
});
