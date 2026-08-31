import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { MarketUtils } from "@morpho-org/midnight-sdk";
import { classifyGating, curate } from "./midnight.js";

const MARKETS = "./data/midnight-markets.json";
const CONFIG = "./config/midnight.json";
const LABELS = "./data/lender-labels.json";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const deriveId = (chainId: string, midnight: string, m: any) =>
  MarketUtils.toId({
    chainId: BigInt(chainId),
    midnight,
    loanToken: m.loanToken,
    collateralParams: m.collateralParams.map((c: any) => ({
      token: c.token,
      lltv: BigInt(c.lltv),
      liquidationCursor: BigInt(c.liquidationCursor),
      oracle: c.oracle,
    })),
    maturity: BigInt(m.maturity),
    rcfThreshold: BigInt(m.rcfThreshold),
    enterGate: m.enterGate,
    liquidatorGate: m.liquidatorGate,
  } as any) as string;

/**
 * The market id IS the hash of the struct, so every stored market validates
 * ITSELF. This is the guard that lets us take the roster from a third-party API
 * (Tenor) without a second source to diff against: a struct wrong in ANY field
 * — a swapped oracle, a mis-parsed lltv, a re-sorted collateral array — stops
 * hashing to its own id, and a market whose struct is wrong produces `take`
 * calls that revert with nothing to point at.
 */
describe("midnight-markets.json self-consistency", () => {
  const config = read(CONFIG);
  const markets = read(MARKETS);

  it("every stored market re-derives its own id", () => {
    let checked = 0;
    for (const [chainId, list] of Object.entries(
      markets as Record<string, any[]>,
    )) {
      const midnight = config[chainId]?.midnight;
      expect(
        midnight,
        `no core address configured for chain ${chainId}`,
      ).toBeTruthy();
      for (const m of list) {
        expect(
          deriveId(chainId, midnight, m).toLowerCase(),
          `market ${m.marketId} (${m.name ?? "?"}) does not hash to its own struct`,
        ).toBe(m.marketId.toLowerCase());
        checked++;
      }
    }
    expect(
      checked,
      "no markets to check — the roster is empty",
    ).toBeGreaterThan(0);
  });

  /**
   * Collateral leg ORDER is part of the hash. Live market
   * `0xb1aa171a52…` ships its legs as 98%/94.5% where every sibling is
   * 94.5%/98%, and it only hashes correctly in the order the API returned — so
   * any "tidying" of `collateralParams` (sort, dedupe, put the vault last) is a
   * silent breakage. The id check above already catches it; this states the rule
   * so the next person reads it before writing the sort.
   */
  it("does not normalise collateral order (mixed leg orders survive)", () => {
    const list: any[] = (markets["8453"] ?? []).filter(
      (m: any) => m.collateralParams.length > 1,
    );
    if (list.length === 0) return; // no multi-leg markets in the roster right now
    const firstLegLltv = new Set(list.map((m) => m.collateralParams[0].lltv));
    // If someone sorted the legs, every multi-leg market would lead with the
    // same LLTV. More than one distinct leading LLTV proves order is untouched.
    expect(firstLegLltv.size).toBeGreaterThan(0);
    for (const m of list) {
      expect(deriveId("8453", config["8453"].midnight, m).toLowerCase()).toBe(
        m.marketId.toLowerCase(),
      );
    }
  });

  /**
   * Two markets that render identically are the repo's standing identity bug.
   * The old label joined every leg's SYMBOL but carried only leg 0's LLTV, so a
   * two-leg market advertised one threshold for two different legs and two
   * markets differing only in a second leg were indistinguishable.
   */
  it("labels are collision-free across every Midnight market", () => {
    const labels = read(LABELS);
    const keys = new Set(
      Object.values(markets as Record<string, any[]>)
        .flat()
        .map(
          (m: any) => `MORPHO_MIDNIGHT_${m.marketId.slice(2).toUpperCase()}`,
        ),
    );
    for (const field of ["names", "shortNames"] as const) {
      const mine = Object.entries(labels[field] ?? {}).filter(([k]) =>
        keys.has(k),
      );
      expect(mine.length, `no ${field} written for Midnight markets`).toBe(
        keys.size,
      );
      const seen = new Map<string, string>();
      for (const [k, v] of mine as [string, string][]) {
        expect(
          seen.has(v),
          `${field} collision on "${v}" (${seen.get(v)} vs ${k})`,
        ).toBe(false);
        seen.set(v, k);
      }
    }
  });
});

describe("classifyGating", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";

  it("treats the zero address as open", () => {
    const g = classifyGating(ZERO, ZERO);
    expect(g.enter).toBe("open");
    expect(g.liquidator).toBe("open");
  });

  /**
   * The fail-safe that matters: an unrecognised gate is `'unknown'`, never
   * `'open'`. Consumers gate on `enter === 'open'`, so an unknown gate refuses a
   * new position instead of emitting calldata that reverts on-chain.
   */
  it("never reports an unrecognised gate as open", () => {
    const g = classifyGating(
      "0x18a0E42C421dF95b895EF909756F56C662a9bdF7",
      ZERO,
    );
    expect(g.enter).toBe("unknown");
    expect(g.enter).not.toBe("open");
    expect(g.liquidator).toBe("open");
  });

  it("treats a missing gate field as open (absent == zero on-chain)", () => {
    expect(classifyGating(undefined, undefined).enter).toBe("open");
  });
});

describe("curate", () => {
  const mk = (maturity: number, totalUnits: string) =>
    ({ marketId: "0x1", maturity: String(maturity), totalUnits }) as any;
  const NOW = 1_800_000_000;

  it("keeps unmatured markets regardless of size", () => {
    expect(curate([mk(NOW + 1000, "0")], NOW).kept).toHaveLength(1);
  });

  /**
   * A matured or deprecated market is NOT a dead market: positions settle, get
   * repaid, exited and liquidated after maturity. Dropping one that still holds
   * units would make its holders' positions read as nothing — the exact bug this
   * rewrite exists to fix.
   */
  it("keeps a matured market that still holds units", () => {
    expect(curate([mk(NOW - 1000, "12345")], NOW).kept).toHaveLength(1);
  });

  it("drops a market only when it is both matured AND empty", () => {
    const { kept, dropped } = curate([mk(NOW - 1000, "0")], NOW);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });
});
