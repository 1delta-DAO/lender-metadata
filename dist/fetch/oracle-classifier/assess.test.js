import { describe, expect, it } from "vitest";
import { assessFeed } from "./assess.js";
import { resolveFeed } from "./feedResolver.js";
/** Build a ResolvedFeed with sensible defaults for the fields a test doesn't set. */
function feed(partial) {
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
        const a = assessFeed(feed({
            provider: "pendle-pt",
            priceDescription: "USDT / USD",
            rawDescription: "PT Capped srUSDe USDT/USD linear discount 25JUN2026",
        }), "PT-srUSDe-25JUN2026", "USD");
        expect(a.correctOracle).toBe(true);
        expect(a.denominatorMatch).toBe(true); // USD numeraire matches
    });
    it("matches case-insensitively across the PT symbol and adapter underlying", () => {
        const a = assessFeed(feed({
            provider: "pendle-pt",
            priceDescription: "USDT / USD",
            rawDescription: "PT Capped sUSDe USDT/USD linear discount 07MAY2026",
        }), "PT-sUSDE-7MAY2026", "USD");
        expect(a.correctOracle).toBe(true);
    });
    it("flags a genuinely mis-wired PT adapter (underlying disagrees)", () => {
        const a = assessFeed(feed({
            provider: "pendle-pt",
            priceDescription: "USDT / USD",
            rawDescription: "PT Capped USDe USDT/USD linear discount 27NOV2025",
        }), "PT-srUSDe-25JUN2026", // adapter says USDe, reserve is srUSDe
        "USD");
        expect(a.correctOracle).toBe(false);
    });
    it("leaves correctness unverified when the underlying can't be parsed", () => {
        const a = assessFeed(feed({
            provider: "pendle-pt",
            priceDescription: "USDT / USD",
            rawDescription: "linear discount adapter", // no extractable underlying
        }), "PT-srUSDe-25JUN2026", "USD");
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
        const nodes = new Map([
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
describe("assessFeed — Aave price-cap adapters", () => {
    it("same-asset cap is correct (Capped USDC/USD for USDC)", () => {
        const a = assessFeed(feed({ provider: "price-cap", priceDescription: "USDC / USD", rawDescription: "Capped USDC/USD" }), "USDC", "USD");
        expect(a.correctOracle).toBe(true);
        expect(a.denominatorMatch).toBe(true);
    });
    it("alias cap is correct (USDbC priced by Capped USDC/USD)", () => {
        const a = assessFeed(feed({ provider: "price-cap", priceDescription: "USDC / USD", rawDescription: "Capped USDC/USD" }), "USDbC", "USD");
        expect(a.correctOracle).toBe(true);
    });
    it("cross-asset cap is a correlated proxy (USDe via Capped USDT/USD) → not correct", () => {
        // The scorer treats provider==price-cap + correctOracle==false as a moderate
        // 'correlated-proxy', not a hard wrong-asset.
        const a = assessFeed(feed({ provider: "price-cap", priceDescription: "USDT / USD", rawDescription: "Capped USDT/USD" }), "USDe", "USD");
        expect(a.correctOracle).toBe(false);
        expect(a.denominatorMatch).toBe(true);
    });
    it("resolveFeed classifies a 'Capped …' adapter as price-cap", () => {
        const cap = "0xc26d4a1c46d884cff6de9800b6ae7a8cf48b4ff8";
        const nodes = new Map([
            [
                cap,
                {
                    address: cap,
                    rawDescription: "Capped USDT/USD",
                    description: "USDT / USD", // the cap adapter is itself the terminal node
                    decimals: 8,
                    dataFeedId: null,
                    pointers: {},
                },
            ],
        ]);
        const resolved = resolveFeed(cap, nodes);
        expect(resolved.provider).toBe("price-cap");
        expect(resolved.priceDescription).toBe("USDT / USD");
        expect(assessFeed(resolved, "USDe", "USD").correctOracle).toBe(false);
    });
});
describe("assessFeed — regression: ordinary feeds keep wrong-asset detection", () => {
    it("flags a plain chainlink feed pricing the wrong asset", () => {
        const a = assessFeed(feed({
            provider: "chainlink",
            priceDescription: "USDT / USD",
            rawDescription: "USDT / USD",
        }), "DAI", "USD");
        expect(a.correctOracle).toBe(false);
    });
    it("passes a correct chainlink feed", () => {
        const a = assessFeed(feed({
            provider: "chainlink",
            priceDescription: "WBTC / USD",
            rawDescription: "WBTC / USD",
        }), "WBTC", "USD");
        expect(a.correctOracle).toBe(true);
        expect(a.denominatorMatch).toBe(true);
    });
});
