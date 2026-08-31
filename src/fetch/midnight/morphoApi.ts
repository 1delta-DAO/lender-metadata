// ============================================================================
// Morpho's hosted Midnight API — the FALLBACK rung of the roster ladder, and
// the source of two fields Tenor does not publish (`market_family_id`,
// `listed`).
//
// It reads `GET /markets?chainId=`, NOT `GET /books`. That distinction is the
// whole bug this replaces: `/books` only returns markets with a RESTING ORDER
// BOOK, so a market holding real positions but quoting nothing never entered the
// roster — and every holder's position then read as nothing. A liquidity view is
// not a roster.
// ============================================================================

/** Normalized Midnight market from Morpho's hosted API. */
export interface MorphoMidnightMarket {
  marketId: string;
  chainId: string;
  loanToken: string;
  /** Ordered — index is the on-chain `collateralIndex`. Never re-sort. */
  collaterals: {
    token: string;
    oracle: string;
    lltv: string;
    liquidationCursor: string;
  }[];
  maturity: string;
  rcfThreshold: string;
  enterGate: string;
  liquidatorGate: string;
  settlementFeeCbp?: number[];
  continuousFee?: string;
  /** The roll SERIES this maturity belongs to. Morpho-only field. */
  marketFamilyId?: string;
  /** Morpho's own curation flag. Morpho-only field. */
  listed?: boolean;
  totalUnits?: string;
}

const str = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);

/**
 * Page through `GET {base}/markets?chainId=` for one chain.
 *
 * **The `chainId` query parameter is not honoured** — asking for chain 8453
 * returns Ethereum markets too (and asking for a nonexistent chain returns the
 * full set), so every row is filtered client-side on its own `chain_id`. Without
 * that, an Ethereum market lands in Base's roster keyed to Base's `midnight`
 * address, which is unusable. This was caught only by the market-id
 * re-derivation in the updater; nothing else would have flagged it.
 *
 * Throws on transport failure or an empty result — like the Tenor client, an
 * empty roster must never be mistaken for an authoritative "no markets".
 */
export async function fetchMorphoMidnightMarkets(
  apiBase: string,
  chainId: string,
): Promise<MorphoMidnightMarket[]> {
  const base = apiBase.replace(/\/+$/, "");
  const raw: any[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 200; page++) {
    const url = `${base}/markets?chainId=${encodeURIComponent(chainId)}&limit=100${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Midnight markets HTTP ${res.status}`);
    const json: any = await res.json();
    for (const m of json?.data ?? []) raw.push(m);
    cursor = json?.cursor ?? null;
    if (!cursor) break;
  }

  // The server ignores `chainId` — filter here, before anything trusts a row.
  const forChain = raw.filter(
    (m: any) => String(m?.chain_id) === String(chainId),
  );
  if (forChain.length === 0)
    throw new Error(`Midnight API returned no markets for chain ${chainId}`);

  const out: MorphoMidnightMarket[] = [];
  for (const m of forChain) {
    if (!m?.market_id || !m?.loan_token || !Array.isArray(m?.collaterals))
      continue;
    if (m.collaterals.length === 0) continue;

    // `settlement_fee_schedule` is an array of {time_to_maturity_days, fee_cbp}
    // in TTM order; we store just the 7 cbp values, matching the on-chain
    // `marketState` layout the updater snapshots.
    const sched = Array.isArray(m.settlement_fee_schedule)
      ? m.settlement_fee_schedule.map((f: any) => Number(f?.fee_cbp ?? 0))
      : undefined;

    out.push({
      marketId: m.market_id,
      chainId: String(m.chain_id ?? chainId),
      loanToken: m.loan_token,
      collaterals: m.collaterals.map((c: any) => ({
        token: c.token,
        oracle: c.oracle,
        lltv: String(c.lltv),
        liquidationCursor: String(c.liquidation_cursor),
      })),
      maturity: String(m.maturity),
      rcfThreshold: String(m.rcf_threshold),
      enterGate: m.enter_gate,
      liquidatorGate: m.liquidator_gate,
      settlementFeeCbp: sched && sched.length === 7 ? sched : undefined,
      continuousFee: str(m.continuous_fee_rate),
      marketFamilyId: str(m.market_family_id),
      listed: typeof m.listed === "boolean" ? m.listed : undefined,
      totalUnits: str(m.total_units),
    });
  }
  return out;
}
