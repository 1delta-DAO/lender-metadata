import { describe, expect, it } from "vitest";
import { assessFeed } from "./assess.js";
import { resolveFeed, type FeedNode, type ResolvedFeed } from "./feedResolver.js";

/** Build a ResolvedFeed with sensible defaults for the fields a test doesn't set. */
function feed(partial: Partial<ResolvedFeed>): ResolvedFeed {
  return {
    priceDescription: "UNKNOWN",
    rawDescription: null,
    provider: "chainlink",
    fixedRate: null,
    underlyingAggregator: null,
    sourcePath: [],
    ...partial,
  };
}

describe("assessFeed — Pendle PT price-cap adapters", () => {
  // The real-world false positive: PT-srUSDe priced by a "PT Capped srUSDe
  // USDT/USD linear discount" adapter that resolves to the USDT/USD numeraire feed.
  it("does NOT flag wrong-asset when the adapter underlying matches the PT", () => {
    const a = assessFeed(
      feed({
        provider: "pendle-pt",
        priceDescription: "USDT / USD",
        rawDescription: "PT Capped srUSDe USDT/USD linear discount 25JUN2026",
      }),
      "PT-srUSDe-25JUN2026",
      "USD"
    );
    expect(a.correctOracle).toBe(true);
    expect(a.denominatorMatch).toBe(true); // USD numeraire matches
  });

  it("matches case-insensitively across the PT symbol and adapter underlying", () => {
    const a = assessFeed(
      feed({
        provider: "pendle-pt",
        priceDescription: "USDT / USD",
        rawDescription: "PT Capped sUSDe USDT/USD linear discount 07MAY2026",
      }),
      "PT-sUSDE-7MAY2026",
      "USD"
    );
    expect(a.correctOracle).toBe(true);
  });

  it("flags a genuinely mis-wired PT adapter (underlying disagrees)", () => {
    const a = assessFeed(
      feed({
        provider: "pendle-pt",
        priceDescription: "USDT / USD",
        rawDescription: "PT Capped USDe USDT/USD linear discount 27NOV2025",
      }),
      "PT-srUSDe-25JUN2026", // adapter says USDe, reserve is srUSDe
      "USD"
    );
    expect(a.correctOracle).toBe(false);
  });

  it("leaves correctness unverified when the underlying can't be parsed", () => {
    const a = assessFeed(
      feed({
        provider: "pendle-pt",
        priceDescription: "USDT / USD",
        rawDescription: "linear discount adapter", // no extractable underlying
      }),
      "PT-srUSDe-25JUN2026",
      "USD"
    );
    expect(a.correctOracle).toBeNull();
  });
});

describe("resolveFeed — Pendle PT adapter classification (end to end)", () => {
  // A PT cap adapter that exposes an `aggregator` pointer to its numeraire feed.
  // Before the fix it classified as "chainlink" (via the aggregator) and read as
  // USDT/USD; now it must classify as "pendle-pt" while still resolving the
  // numeraire pair from the terminal feed.
  it("classifies the adapter as pendle-pt and resolves the numeraire pair", () => {
    const pt = "0x9f336eb940730596548c342a8bf1fc530b10cc96";
    const term = "0xa0dc0249c32fa79e8b9b17c735908a60b1141b40";
    const nodes = new Map<string, FeedNode>([
      [
        pt,
        {
          address: pt,
          rawDescription: "PT Capped srUSDe USDT/USD linear discount 25JUN2026",
          description: null, // not a clean "A / B" → resolver follows the aggregator
          decimals: 8,
          dataFeedId: null,
          pointers: { aggregator: term },
        },
      ],
      [
        term,
        {
          address: term,
          rawDescription: "USDT / USD",
          description: "USDT / USD",
          decimals: 8,
          dataFeedId: null,
          pointers: {},
        },
      ],
    ]);

    const resolved = resolveFeed(pt, nodes);
    expect(resolved.provider).toBe("pendle-pt");
    expect(resolved.priceDescription).toBe("USDT / USD");

    // …and assessment no longer reads it as wrong-asset.
    const a = assessFeed(resolved, "PT-srUSDe-25JUN2026", "USD");
    expect(a.correctOracle).toBe(true);
    expect(a.denominatorMatch).toBe(true);
  });
});

describe("assessFeed — regression: ordinary feeds keep wrong-asset detection", () => {
  it("flags a plain chainlink feed pricing the wrong asset", () => {
    const a = assessFeed(
      feed({
        provider: "chainlink",
        priceDescription: "USDT / USD",
        rawDescription: "USDT / USD",
      }),
      "DAI",
      "USD"
    );
    expect(a.correctOracle).toBe(false);
  });

  it("passes a correct chainlink feed", () => {
    const a = assessFeed(
      feed({
        provider: "chainlink",
        priceDescription: "WBTC / USD",
        rawDescription: "WBTC / USD",
      }),
      "WBTC",
      "USD"
    );
    expect(a.correctOracle).toBe(true);
    expect(a.denominatorMatch).toBe(true);
  });
});
