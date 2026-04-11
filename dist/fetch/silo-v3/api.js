// Discover Silo v3 pairs via the public GraphQL API.
//
// Endpoint: POST https://api-v3.silo.finance
//
// The `silos` query returns one entry per lending pair. Each pair exposes
// `configAddress` (== siloConfig), the pair-level `gaugeHookReceiver`, and
// both side markets (`market1`, `market2`) nested with every static field
// we need — share tokens, oracles, IRM, full fee vector, `lt`/`maxLtv`,
// `liquidationTargetLtv`, `keeperFee`, and the underlying token. That makes
// the on-chain `SiloConfig.getConfig` pass we still run for v2 unnecessary
// here.
const API_URL = "https://api-v3.silo.finance";
const SILOS_QUERY = `
query silosPage($limit: Int!, $after: String) {
  silos(limit: $limit, after: $after) {
    items {
      id
      chainId
      name
      configAddress
      gaugeHookReceiver
      market1 { ...MarketFields }
      market2 { ...MarketFields }
    }
    pageInfo { hasNextPage endCursor }
  }
}
fragment MarketFields on market {
  id
  index
  inputToken { id symbol decimals }
  sTokenId
  spTokenId
  dTokenId
  lt
  maxLtv
  liquidationTargetLtv
  daoFee
  deployerFee
  flashLoanFee
  liquidationFee
  keeperFee
  solvencyOracleAddress
  maxLtvOracleAddress
  interestRateModelId
}
`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
function lower(s) {
    return (s ?? "").toLowerCase();
}
async function fetchSilosPage(limit, after) {
    const res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            query: SILOS_QUERY,
            variables: { limit, after },
        }),
    });
    if (!res.ok) {
        throw new Error(`silo v3 api error: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json());
    if (body.errors?.length) {
        throw new Error(`silo v3 api graphql errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data?.silos ?? { items: [] };
}
function toHalf(m) {
    return {
        silo: lower(m.id),
        token: lower(m.inputToken?.id),
        decimals: m.inputToken?.decimals ?? 0,
        symbol: m.inputToken?.symbol,
        index: m.index,
        protectedShareToken: lower(m.spTokenId),
        collateralShareToken: lower(m.sTokenId),
        debtShareToken: lower(m.dTokenId),
        solvencyOracle: lower(m.solvencyOracleAddress),
        maxLtvOracle: lower(m.maxLtvOracleAddress),
        interestRateModel: lower(m.interestRateModelId),
        maxLtv: m.maxLtv,
        lt: m.lt,
        liquidationTargetLtv: m.liquidationTargetLtv,
        liquidationFee: m.liquidationFee,
        flashloanFee: m.flashLoanFee,
        daoFee: m.daoFee,
        deployerFee: m.deployerFee,
        keeperFee: m.keeperFee ?? undefined,
    };
}
/**
 * Fetch every Silo v3 lending pair from the GraphQL API and group them by
 * chainId as one `SiloV3MarketEntry[]` per chain.
 */
export async function fetchSiloV3MarketsFromApi() {
    const PAGE = 100;
    const out = {};
    let after = null;
    let guard = 0;
    while (true) {
        if (++guard > 200)
            throw new Error("silo v3 api: pagination guard hit");
        const page = await fetchSilosPage(PAGE, after);
        for (const s of page.items ?? []) {
            if (!s.market1 || !s.market2)
                continue;
            const chainId = String(s.chainId);
            const byIndex = {};
            byIndex[s.market1.index] = toHalf(s.market1);
            byIndex[s.market2.index] = toHalf(s.market2);
            const silo0 = byIndex[0];
            const silo1 = byIndex[1];
            if (!silo0 || !silo1)
                continue;
            const entry = {
                siloConfig: lower(s.configAddress),
                name: s.name ?? `${silo0.symbol ?? "?"}/${silo1.symbol ?? "?"}`,
                hookReceiver: s.gaugeHookReceiver && lower(s.gaugeHookReceiver) !== ZERO_ADDR
                    ? lower(s.gaugeHookReceiver)
                    : undefined,
                silo0,
                silo1,
            };
            (out[chainId] ??= []).push(entry);
        }
        const nextCursor = page.pageInfo?.endCursor ?? null;
        const hasNext = !!page.pageInfo?.hasNextPage;
        if (!hasNext || !nextCursor || nextCursor === after)
            break;
        after = nextCursor;
    }
    return out;
}
