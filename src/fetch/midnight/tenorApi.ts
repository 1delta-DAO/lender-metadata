// ============================================================================
// Tenor GraphQL client — the PRIMARY roster source for Morpho Midnight markets.
//
// Tenor (docs.tenor.finance) is a platform layer over Morpho Midnight, not a
// separate protocol: same core contract, same market ids, same offers. What it
// adds is CURATION. Morpho's `/markets` lists every permissionlessly-created
// market (187 on Base, most of them empty shells); Tenor publishes the ~4
// SERIES it actually operates and the ~36 fixed markets under them, plus the
// per-leg collateral params, the Vault-V2 join for the vault-as-collateral
// structure, and its own deprecation flags.
//
// Keyless and CORS-open. Responses carry `x-ratelimit-*` headers (25/s, 150/10s,
// 1000/rolling) and a per-request complexity budget of 1000 — the roster query
// below costs ~46, so it comfortably fits in one request.
//
// TRAPS (all bit us or nearly did while building this):
//  - GraphQL errors return **HTTP 200** with an `errors` array. A `res.ok` check
//    reads a validation failure as success, so `errors` MUST be inspected.
//  - `first` interacts with the complexity budget: 250 was rejected BAD_REQUEST
//    where 100 was fine.
//  - `Float` rate fields are FRACTIONS (0.0447 = 4.47%); our package convention
//    is nominal APR in PERCENT. (Not used by the roster, but the same endpoint
//    serves rates — do not copy a Float straight into a rate field.)
//  - USD-denominated fields are scaled by 18 decimals.
//  - Collateral leg ORDER is part of the market-id hash. Never sort or dedupe.
// ============================================================================

const DEFAULT_TENOR_API = "https://api.tenor.finance/graphql";

/** One collateral leg exactly as the market struct hashes it. */
export interface TenorCollateral {
  token: string;
  oracle: string;
  lltv: string;
  liquidationCursor: string;
}

/** A single fixed-maturity Midnight market as Tenor serves it. */
export interface TenorFixedMarket {
  /** bytes32 Midnight market id. */
  marketId: string;
  chainId: string;
  loanToken: string;
  /** Ordered — index is the on-chain `collateralIndex`. */
  collaterals: TenorCollateral[];
  maturity: string;
  rcfThreshold: string;
  enterGate: string;
  liquidatorGate: string;
  /** Settlement-fee schedule in cbp, 7 TTM buckets, or undefined if absent. */
  settlementFeeCbp?: number[];
  continuousFee?: string;
  /** Tenor's series id (the roll family in Tenor's own vocabulary). */
  seriesId?: string;
  /** Entry closed at this unix second (market- or series-level), else null. */
  deprecatedAt?: string | null;
  /** Vault-V2 wrapper listed as a collateral leg, when the series has one. */
  collateralVault?: string | null;
  /** Outstanding units — used only to decide whether an empty closed market can be dropped. */
  totalUnits?: string;
}

const ROSTER_QUERY = `{
  morphoFixedMarkets(first: 100) {
    pageInfo { countTotal count }
    items {
      fixedMarketIdentifier
      maturity
      rcfThreshold
      continuousFee
      deprecatedAt
      fees
      tenorMarket {
        id
        chainId
        whitelisted
        deprecatedAt
        morphoVault { address }
      }
      fixedMarketKey {
        chainId
        loanTokenAddress
        maturity
        rcfThreshold
        enterGate
        liquidatorGate
        collaterals { token oracle lltv liquidationCursor }
      }
      state { totalUnits }
    }
  }
}`;

const str = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);

/**
 * Fetch Tenor's curated fixed-market roster.
 *
 * Throws on transport failure, on a GraphQL `errors` array, or on a response
 * that carries no items — every one of those must fall through to the Morpho
 * fallback rather than be mistaken for "Tenor says there are no markets".
 * An empty roster and a broken roster are indistinguishable from here, and
 * treating either as authoritative would wipe the market list.
 */
export async function fetchTenorFixedMarkets(
  apiUrl: string = DEFAULT_TENOR_API,
): Promise<TenorFixedMarket[]> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: ROSTER_QUERY }),
  });
  if (!res.ok) throw new Error(`Tenor API HTTP ${res.status}`);

  const json: any = await res.json();
  // HTTP 200 + an `errors` array is the documented failure shape.
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new Error(
      `Tenor API GraphQL error: ${json.errors
        .map((e: any) => e?.message ?? "?")
        .join("; ")}`,
    );
  }

  const items: any[] = json?.data?.morphoFixedMarkets?.items ?? [];
  if (items.length === 0) throw new Error("Tenor API returned no markets");

  const out: TenorFixedMarket[] = [];
  for (const it of items) {
    const key = it?.fixedMarketKey;
    const marketId = it?.fixedMarketIdentifier;
    // A market whose struct we cannot fully reconstruct is unusable: its id
    // cannot be verified and no `take` can be encoded for it. Skip rather than
    // emit a half-populated row that fails later and further from the cause.
    if (!marketId || !key?.loanTokenAddress || !Array.isArray(key.collaterals))
      continue;
    if (key.collaterals.length === 0) continue;

    const series = it?.tenorMarket ?? {};
    // Deprecation is inherited: a deprecated SERIES closes entry to every market
    // under it, even ones not individually flagged. Take the earlier of the two.
    const depCandidates = [it?.deprecatedAt, series?.deprecatedAt]
      .filter((v) => v !== null && v !== undefined)
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
    const deprecatedAt =
      depCandidates.length > 0 ? String(Math.min(...depCandidates)) : null;

    const fees = Array.isArray(it?.fees)
      ? it.fees.map((f: any) => Number(f))
      : undefined;

    out.push({
      marketId,
      chainId: String(key.chainId ?? series.chainId ?? ""),
      loanToken: key.loanTokenAddress,
      // ORDER PRESERVED — it is part of the market-id hash.
      collaterals: key.collaterals.map((c: any) => ({
        token: c.token,
        oracle: c.oracle,
        lltv: String(c.lltv),
        liquidationCursor: String(c.liquidationCursor),
      })),
      maturity: String(key.maturity ?? it.maturity),
      rcfThreshold: String(key.rcfThreshold ?? it.rcfThreshold),
      enterGate: key.enterGate,
      liquidatorGate: key.liquidatorGate,
      settlementFeeCbp: fees && fees.length === 7 ? fees : undefined,
      continuousFee: str(it?.continuousFee),
      seriesId: str(series?.id),
      deprecatedAt,
      collateralVault: str(series?.morphoVault?.address) ?? null,
      totalUnits: str(it?.state?.totalUnits),
    });
  }
  return out;
}
