// Shared GraphQL client for the Silo v3 indexer
// (`https://api-v3.silo.finance`). Used by both the v2 and v3 fetchers —
// the indexer exposes protocol-tagged silos for both versions, so a single
// paginated query can serve either.
//
// The API docs promise "comprehensive protocol data, including all V3
// silos + vaults and whitelisted V2 silos + vaults", so v2 here means
// *indexed whitelisted v2 markets*. If a v2 market is live on-chain but not
// whitelisted by Silo, it won't appear here.
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
      protocol { protocolVersion }
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
        throw new Error(`silo api error: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json());
    if (body.errors?.length) {
        throw new Error(`silo api graphql errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data?.silos ?? { items: [] };
}
/**
 * Fetches every Silo lending pair from the GraphQL API, paged via the
 * `pageInfo.endCursor` cursor. Returns the raw `GqlSilo[]` list — callers
 * are expected to filter by `protocol.protocolVersion` and map into their
 * on-disk shape.
 */
export async function fetchAllSilos() {
    const PAGE = 100;
    const out = [];
    let after = null;
    let guard = 0;
    while (true) {
        if (++guard > 200)
            throw new Error("silo api: pagination guard hit");
        const page = await fetchSilosPage(PAGE, after);
        for (const s of page.items ?? [])
            out.push(s);
        const nextCursor = page.pageInfo?.endCursor ?? null;
        const hasNext = !!page.pageInfo?.hasNextPage;
        if (!hasNext || !nextCursor || nextCursor === after)
            break;
        after = nextCursor;
    }
    return out;
}
