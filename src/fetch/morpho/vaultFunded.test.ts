import { describe, it, expect } from "vitest";
import {
  MORPHO_VAULT_FUNDED_MIN_USD,
  MORPHO_VAULT_FUNDED_MIN_VAULT_USD,
  sumVaultFundedUnlisted,
} from "./vaultFunded.js";

// Same rule and constants as margin-fetcher's `morpho/vaultFunded.ts` — keep
// these assertions identical to its test so a drift on either side fails.
const A = "0x" + "a".repeat(64);
const B = "0x" + "b".repeat(64);
const COLL = "0x" + "d".repeat(40);
const mkt = (marketId: string, listed: boolean, coll: string | null = COLL) => ({
  marketId,
  listed,
  collateralAsset: coll ? { address: coll } : null,
});

describe("vault-funded unlisted Morpho markets", () => {
  it("uses $10k summed across vaults and a $1k per-vault read floor", () => {
    expect(MORPHO_VAULT_FUNDED_MIN_USD).toBe(10_000);
    expect(MORPHO_VAULT_FUNDED_MIN_VAULT_USD).toBe(1_000);
  });

  it("sums v1 allocations and v2 MarketV1 caps; inclusive at the threshold", () => {
    const out = sumVaultFundedUnlisted(
      [
        { state: { allocation: [{ supplyAssetsUsd: 7_500, market: mkt(A, false) }] } },
        { state: { allocation: [{ supplyAssetsUsd: 9_999, market: mkt(B, false) }] } },
      ],
      [
        {
          asset: { decimals: 6, price: { usd: 1 } },
          caps: { items: [{ type: "MarketV1", allocation: "2500000000", data: { market: mkt(A, false) } }] },
        },
      ]
    );
    expect(out).toEqual([{ marketId: A, vaultUsd: 10_000 }]);
  });

  it("skips listed markets, idle markets and unpriced allocations", () => {
    const out = sumVaultFundedUnlisted(
      [
        {
          state: {
            allocation: [
              { supplyAssetsUsd: 5e6, market: mkt(A, true) },
              { supplyAssetsUsd: 5e6, market: mkt(B, false, null) },
              { supplyAssetsUsd: null, market: mkt(B, false) },
            ],
          },
        },
      ],
      []
    );
    expect(out).toEqual([]);
  });
});
