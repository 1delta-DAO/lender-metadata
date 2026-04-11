# Silo v2 & v3 metadata fetchers

Both fetchers pull from the same public endpoint — the Silo v3 GraphQL
indexer at `https://api-v3.silo.finance` — which serves both v3 silos and
whitelisted v2 silos. Neither fetcher hits an on-chain RPC anymore; the
indexer exposes every static config field we need directly.

## Output files

| Lender  | Markets                      | Peripherals                        |
| ------- | ---------------------------- | ---------------------------------- |
| Silo v2 | `data/silo-v2-markets.json`  | `config/silo-v2-peripherals.json`  |
| Silo v3 | `data/silo-v3-markets.json`  | `config/silo-v3-peripherals.json`  |

Per chain, markets are a list of pairs with the two sides nested as
`silo0` / `silo1` (`index` 0 and 1), sorted by `siloConfig` for stable
output diffs. Each side holds: underlying token, decimals, symbol, share
tokens (collateral / protected / debt), oracles (solvency + maxLtv),
interest rate model, `lt` / `maxLtv` / `liquidationTargetLtv`, and the
full fee vector (`daoFee`, `deployerFee`, `liquidationFee`,
`flashloanFee`; v3 also has `keeperFee`).

## Shared GraphQL client — [silo-shared/graphql.ts](../silo-shared/graphql.ts)

Single paginated `silos { items { ... protocol { protocolVersion } ... } }`
query. `fetchAllSilos()` returns the raw `GqlSilo[]` list across every
version; both updaters filter by `protocol.protocolVersion`. Paged via
`pageInfo.endCursor` cursors in 100s. Each pair carries:

- `configAddress` (== siloConfig)
- `gaugeHookReceiver` (pair-level)
- `market1` / `market2` with `index` (0 / 1), `inputToken { id symbol
  decimals }`, share tokens (`sTokenId` / `spTokenId` / `dTokenId`),
  `lt` / `maxLtv` / `liquidationTargetLtv`, full fee vector (incl.
  `keeperFee`), `solvencyOracleAddress`, `maxLtvOracleAddress`,
  `interestRateModelId`

## Silo v2 — [silo-v2.ts](../silo-v2.ts)

Filters `fetchAllSilos()` on `protocolVersion === "v2"` and maps each
pair into the existing `SiloMarketEntry` shape (see
[silo-v2/types.ts](../silo-v2/types.ts)) so downstream `data-sdk`
consumers keep working without changes.

Caveat: the GraphQL indexer doesn't expose `callBeforeQuote`; we default
it to `false`. Every live v2 market currently has this flag unset, so
the migration is lossless today. If a future market enables it, we'd
either need to add that field upstream or reintroduce a targeted
on-chain read for it.

Peripherals (`factory`, `lens`, `router`, `incentivesController`) remain
hand-maintained in `config/silo-v2-peripherals.json` — v2 has no
published deployments directory and the set changes rarely.

## Silo v3 — [silo-v3.ts](../silo-v3.ts)

Filters `fetchAllSilos()` on `protocolVersion === "v3"` and maps each
pair into the v3 shape (see [silo-v3/types.ts](./types.ts)), which adds
`index` per side, optional `keeperFee`, and lifts `hookReceiver` to the
pair level.

Peripherals are pulled from the official
`silo-finance/silo-contracts-v3` repo at fetch time
([peripherals.ts](./peripherals.ts)). For each chain dir under
`silo-core/deployments/<chain>/` and `silo-vaults/deployments/<chain>/`
we `fetch()` each contract's `<Name>.sol.json` file from
`raw.githubusercontent.com` and pull the `address` field. Files that
404 are skipped silently (not every contract ships on every chain).
Pinned to `develop` via the `REF` constant; swap to a commit SHA for
reproducibility.

Captured: `factory`, `lens`, `router`, `leverageRouter`,
`siloDeployer`, `incentivesControllerFactory`, `tower`,
`dynamicKinkModelFactory`, `interestRateModelV2Factory`,
`vaultsFactory`, `vaultDeployer`, `publicAllocator`,
`idleVaultsFactory`, `incentivesControllerCLFactory`.

The chain-dir → chainId map lives in `DEPLOYMENT_DIR_TO_CHAIN_ID` in
[peripherals.ts](./peripherals.ts). Add new chains there as Silo
publishes them.

## Labels — [silo-labels.ts](../silo-labels.ts)

Both updaters also write `./data/lender-labels.json`. `buildSiloLabels`
emits one entry per silo *side* keyed as
`SILO_V{N}_<UPPER_SILO_ADDRESS>` — matching the per-side reserve uid
convention — with `<thisSym>/<otherSym>` as the display name (from that
side's perspective). Short names use the prefixes `S2` / `S3`. The
merge preserves the shared default lender labels via
`defaults[labelsFile]`.

## Runtime data

The indexer also exposes every runtime field we'd otherwise read via
`SiloLens` multicall: `supply`, `borrowed`, `liquidity`, `utilization`,
`borrowRate`, `depositRate`, plus USD-priced versions and bad-debt
flags. These are intentionally *not* persisted to this repo — it holds
static metadata only — but runtime fetchers could hit the same endpoint
if they can tolerate indexer lag (see `lastUpdatedTimestamp` on
`market`). For anything that needs latest-block accuracy (liquidation
bots, etc.), keep reading from the chain.

## Merge semantics

Both updaters overwrite markets one chain at a time in `mergeData`, so a
partial API failure on one chain doesn't wipe unrelated chains.
Peripherals are merged per-chain and per-key so a missing file on one
run doesn't drop previously-known addresses.
