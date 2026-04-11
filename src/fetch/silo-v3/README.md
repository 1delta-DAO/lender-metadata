# Silo v2 & v3 metadata fetchers

Both fetchers produce the same on-disk shape — one `SiloMarketEntry` per
lending pair, keyed by chainId — but get there via different sources
because v2 and v3 expose different public APIs.

## Output files

| Lender  | Markets                      | Peripherals                        |
| ------- | ---------------------------- | ---------------------------------- |
| Silo v2 | `data/silo-v2-markets.json`  | `config/silo-v2-peripherals.json`  |
| Silo v3 | `data/silo-v3-markets.json`  | `config/silo-v3-peripherals.json`  |

Per chain, markets are a list of pairs with the two sides nested as
`silo0` / `silo1` (`index` 0 and 1). Each side holds: underlying token,
decimals, symbol, share tokens (collateral / protected / debt), oracles
(solvency + maxLtv), interest rate model, `lt` / `maxLtv` /
`liquidationTargetLtv`, and the full fee vector (`daoFee`, `deployerFee`,
`liquidationFee`, `flashloanFee`; v3 also has `keeperFee`).

## Silo v2 — [silo-v2.ts](../silo-v2.ts)

Two-stage fetch because the v2 public endpoint doesn't expose the static
config fields.

1. **Discovery** — `POST https://v2.silo.finance/api/borrow`
   ([api.ts](../silo-v2/api.ts)). Paginated by `offset` / `limit`; returns
   one entry per pair with each side's silo address, underlying token,
   decimals, symbol. Dedupe by `(chainId, marketId)`.

2. **Static config** — `SiloConfig.getConfig(silo)` multicall per side
   ([fetcher.ts](../silo-v2/fetcher.ts)). Fills in share tokens, oracles,
   IRM, `lt` / `maxLtv`, fees, hook receiver. This is the only on-chain
   path in the fetcher.

Peripherals (`factory`, `lens`, `router`, `incentivesController`) are
hand-maintained in `config/silo-v2-peripherals.json` — v2 has no public
endpoint that lists them and the set rarely changes.

## Silo v3 — [silo-v3.ts](../silo-v3.ts)

One GraphQL call, no on-chain stage. The v3 indexer exposes every static
field we need on the `market` type directly.

1. **Discovery + static config** — `POST https://api-v3.silo.finance`
   ([api.ts](./api.ts)). A paginated `silos { items { ... } }` query
   returns one entry per pair with `configAddress` (== siloConfig),
   pair-level `gaugeHookReceiver`, and both `market1` / `market2` nested
   with share tokens (`sTokenId` / `spTokenId` / `dTokenId`), oracles
   (`solvencyOracleAddress` / `maxLtvOracleAddress`),
   `interestRateModelId`, `lt` / `maxLtv` / `liquidationTargetLtv`, full
   fee vector, `keeperFee`, and nested `inputToken { id symbol decimals }`.
   Sides are keyed by `market.index` (0 / 1) for deterministic silo0 /
   silo1 assignment. Paginated via `pageInfo.endCursor` cursors.

2. **Peripherals** — pulled from the official
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

## Why the approaches differ

The v2 borrow-list endpoint only publishes what a borrow-UI needs —
silo addresses and underlying tokens — so we still need on-chain calls
to fill in the static config. The v3 GraphQL indexer publishes
everything, making the on-chain stage redundant for static metadata.

GraphQL freshness is block-delayed (see `lastUpdatedTimestamp` on
`market`). That's fine for a static metadata snapshot like this one, but
runtime state (liquidity, utilization, rates) that needs latest-block
accuracy should still be read from the chain.

## Merge semantics

Both updaters overwrite markets one chain at a time in `mergeData`, so a
partial RPC / API failure on one chain doesn't wipe unrelated chains.
Peripherals are merged per-chain and per-key so a missing file on one
run doesn't drop previously-known addresses.
