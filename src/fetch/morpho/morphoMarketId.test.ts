import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  computeMorphoMarketId,
  lenderKeyToMorphoMarketId,
  marketTripletKey,
  morphoMarketIdToLenderKey,
} from "./morphoMarketId.js";

describe("computeMorphoMarketId", () => {
  it("matches Morpho docs example (mainnet USDT / Pendle market)", () => {
    const id = computeMorphoMarketId({
      loanToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      collateralToken: "0x8ddac7aa85Ce324AF75a3bFcB876375555d43BB8",
      oracle: "0xF47020f01e77257Fe86B9ECb36552486E0Ae66e0",
      irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
      lltv: "915000000000000000",
    });
    expect(id).toBe(
      "0x9a33209eee9e93f5f7aed04085f9f5e0ce9a7a103c476f5c30a0e5ca03c3d540"
    );
  });

  it("marketTripletKey is stable", () => {
    expect(marketTripletKey("0xA", "0xb", "0xc")).toBe(
      "0xa:0xb:0xc"
    );
  });

  it("morphoMarketIdToLenderKey round-trips with lenderKeyToMorphoMarketId", () => {
    const id =
      "0x9a33209eee9e93f5f7aed04085f9f5e0ce9a7a103c476f5c30a0e5ca03c3d540";
    const lk = morphoMarketIdToLenderKey(id);
    expect(lenderKeyToMorphoMarketId(lk)).toBe(id);
  });
});

describe("lender-labels MORPHO_BLUE_* suffix (optional consistency check)", () => {
  it("suffix matches marketId hex without 0x uppercase for sampled keys", () => {
    const raw = readFileSync(
      new URL("../../../data/lender-labels.json", import.meta.url),
      "utf8"
    );
    const labels = JSON.parse(raw) as { names?: Record<string, string> };
    const names = labels.names ?? {};
    const morphoKeys = Object.keys(names).filter(
      (k) => k.startsWith("MORPHO_BLUE_") && k !== "MORPHO_BLUE"
    );
    expect(morphoKeys.length).toBeGreaterThan(0);
    for (const k of morphoKeys.slice(0, 50)) {
      const suffix = k.slice("MORPHO_BLUE_".length);
      expect(suffix).toMatch(/^[0-9A-F]{64}$/);
      const marketId = `0x${suffix.toLowerCase()}`;
      expect(marketId.length).toBe(66);
    }
  });
});
