# Silo v2 Public Data Fetcher

Fetches protocol-level metadata for Silo Finance v2 isolated markets.

## Architecture

Each Silo v2 **market** is a pair `(silo0, silo1)` deployed by `SiloFactory`
and sharing one `SiloConfig`. Each silo is itself an ERC-4626 vault for one
borrowable asset; the *other* silo's asset is the collateral side. Both sides
are borrowable, and `lt`/`maxLtv`/`oracle`/fees can differ per silo.

We model the protocol as a **single lender** (`Lender.SILO_V2`) holding many
`(silo0, silo1)` pairs per chain. Each pair expands into **two** reserve
entries inside the `SILO_V2` lender bucket — one per silo — both with
`borrowingEnabled` and `collateralActive` set to `true`. The collateral
factor of a reserve is the LLTV of the *opposite* silo (the side providing
collateral when borrowing this asset).

## MarketUid

```
SILO_V2:{chainId}:{siloAddress}
```

The reserve key is the **silo (vault) address**, not the underlying token —
the same token may appear in multiple silos backed by different counterparties.

## Static vs dynamic data

To keep the fetcher lightweight, almost everything that doesn't change at
block-time is precomputed in `data-sdk` at initializer time:

| Data | Where |
|------|-------|
| Silo addresses + underlying / decimals / symbol | `siloMarkets()` |
| `lt`, `maxLtv`, `liquidationTargetLtv` | `siloMarkets()` |
| `daoFee`, `deployerFee`, `liquidationFee`, `flashloanFee` | `siloMarkets()` |
| Share token addresses (collateral / protected / debt) | `siloMarkets()` |
| `solvencyOracle`, `maxLtvOracle`, `interestRateModel` | `siloMarkets()` |
| `hookReceiver`, `callBeforeQuote` | `siloMarkets()` |
| `siloConfig` (per pair) | `siloMarkets()` |
| `SiloLens`, `SiloFactory` (per chain) | `siloPeripherals()` |

The on-chain fetcher only emits **3 calls per silo (6 per pair)**:

1. `Silo.totalAssets()` — total deposits incl. accrued interest
2. `Silo.getDebtAssets()` — total borrows
3. `SiloLens.getDepositAPR(silo)` — supply APR (1e18 = 100%/yr)

The borrow APR is derived in the parser from
`borrowAPR = depositAPR / (utilization * (1 - daoFee - deployerFee))`
to save 1 call per silo. If precision becomes a problem we can swap that
identity out for an explicit `SiloLens.getBorrowAPR(silo)` call.

## ABI surface

Defined in [`packages/margin-fetcher/src/abis/silo-v2/`](../../../abis/silo-v2):

- `SiloConfigAbi` — `getConfig(silo)`, `getSilos()`. **Not used by the
  fetcher hot path** — only by the initializer / liquidation tooling.
- `SiloAbi` — `totalAssets()`, `getDebtAssets()`, `getCollateralAssets()`,
  `asset()`.
- `SiloLensAbi` — `getDepositAPR`, `getBorrowAPR`, `getUtilization`,
  `getRawLiquidity`. This is the **v2** lens; the v1 page on
  `devdocs.silo.finance/smart-contracts-overview/silolens` is unrelated.

## Files

| File | Purpose |
|------|---------|
| `publicCallBuild.ts` | Emits the 6-calls-per-pair multicall payload |
| `publicCallParse.ts` | Decodes results, joins with `siloMarkets()` static data, emits one reserve per silo |
| `README.md` | This file |
