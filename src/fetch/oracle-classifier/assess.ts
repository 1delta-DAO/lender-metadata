import { parsePair, symbolsMatch } from "./normalize.js";
import type { ResolvedFeed } from "./feedResolver.js";

export type Assessment = {
  /** Denominator the feed reports the asset in, e.g. "USD". */
  denominator: string | null;
  /** What the feed *should* report: "<assetSymbol> / <numeraire>". */
  intendedPair: string | null;
  /**
   * Does the actual source price the *intended asset*? (numerator match)
   * true  — reported numerator matches the asset being priced (alias-aware).
   * false — the feed prices a different asset than intended.
   * null  — could not verify (constant feed, unresolved/composite description, missing symbol).
   *
   * This is the primary "right source for the right asset" signal. The denominator
   * (USD vs ETH vs a token) is reported separately via `denominatorMatch` because
   * markets legitimately mix numeraires (e.g. Aave V2: stables in USD, volatiles in ETH).
   */
  correctOracle: true | false | null;
  /**
   * Does the feed's denominator match the protocol numeraire? (secondary signal)
   * Surfaces cross-numeraire wiring (e.g. a USD feed in an ETH-denominated market)
   * without polluting `correctOracle`. null when either side is unknown.
   */
  denominatorMatch: true | false | null;
};

/**
 * Compares a resolved feed's reported pair against the asset it is supposed to price
 * and the protocol's numeraire (the unit of account, e.g. "USD" or "ETH").
 *
 * Shared across every lender's classifier — the lender layer only has to supply the
 * intended asset symbol and the numeraire; the matching (incl. wrapped-token aliases)
 * lives here.
 */
export function assessFeed(
  resolved: ResolvedFeed,
  assetSymbol: string | null,
  numeraire: string | null
): Assessment {
  const pair = parsePair(resolved.priceDescription);
  const denominator = pair?.quote ?? null;
  const intendedPair =
    assetSymbol && numeraire ? `${assetSymbol} / ${numeraire}` : null;

  const verifiable =
    !resolved.fixedRate &&
    !!pair &&
    resolved.priceDescription !== "UNKNOWN" &&
    // composite "X * Y / Z" descriptions don't map to a single asset/numeraire pair
    !resolved.priceDescription.includes(" * ");

  const correctOracle: true | false | null =
    verifiable && assetSymbol ? symbolsMatch(pair!.base, assetSymbol) : null;

  const denominatorMatch: true | false | null =
    verifiable && numeraire && pair!.quote
      ? symbolsMatch(pair!.quote, numeraire)
      : null;

  return { denominator, intendedPair, correctOracle, denominatorMatch };
}

/**
 * The most common denominator across a set of feed pairs == the market's unit of
 * account. Robust against markets whose on-chain BASE_CURRENCY is unreadable (legacy
 * Aave V2 is ETH-denominated but exposes no BASE_CURRENCY()). Returns uppercased.
 */
export function dominantDenominator(denoms: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const d of denoms) {
    if (!d) continue;
    const key = d.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [d, n] of counts) {
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}
