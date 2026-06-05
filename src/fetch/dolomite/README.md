# Dolomite updater

Snapshots Dolomite's on-chain market list into `config/dolomite-margin.json`
(keyed by chainId → `{ dolomiteMargin, expiry, markets }`). Registered in
[update-dataset.ts](../../update-dataset.ts) as `DolomiteUpdater`.

## What Dolomite is (and why the metadata is small)

Dolomite is a **single global cross-margin pool** — one `DolomiteMargin` core
contract per chain that holds every asset, indexed by an integer `marketId`
(not by token address). This is unlike Aave/Morpho (per-reserve / per-market
contracts) and unlike Fluid (introspective resolvers). So the only per-chain
metadata a consumer can't derive on its own is:

1. the **`DolomiteMargin` (+ `Expiry`) addresses** — static, from the protocol's
   `deployed.json`; and
2. the **`marketId → token` map** — `marketId`s are assigned by Dolomite
   governance and **cannot be derived from the token address**, so they must be
   read on-chain and cached here.

Everything else (rates, prices, totals, risk params, per-user positions) is
fetched live by `@1delta/margin-fetcher` — via the Dolomite subgraph where
available, with an on-chain fallback that fans out over exactly this `markets`
id list. Publishing the id list is what lets the synchronous on-chain call
builder run without a `getNumMarkets` round-trip.

## How the markets map is read

For each deployed chain:

1. `getNumMarkets()` → `n`
2. `getMarketTokenAddress(0..n-1)` → token per market (lowercased)

Both are **granular getters** that are stable across DolomiteMargin versions —
deliberately avoiding `getMarketWithInfo`, whose struct differs between the
deployed contracts and the latest source (it mis-decodes on the live mainnet
deployments).

Reads go through `@1delta/providers`' `multicallRetryUniversal`. Two chains
(Polygon zkEVM `1101`, Superseed `5330`) are not in that package's viem chain
registry, so the fetcher falls back to a **direct viem client** with a hardcoded
RPC for those (`DOLOMITE_FALLBACK_RPCS`).

## File layout

| File | Purpose |
| --- | --- |
| [constants.ts](./constants.ts) | `DOLOMITE_DEPLOYMENTS` (margin/expiry addresses per chain, non-testnet), `DOLOMITE_FALLBACK_RPCS`, and the minimal `getNumMarkets` / `getMarketTokenAddress` read ABI |
| [fetcher.ts](./fetcher.ts) | `fetchDolomiteMarkets(chainId, margin)` — multicall path + direct-RPC fallback, returns the `marketId → token` map |
| [dolomite.ts](../dolomite.ts) | `DolomiteUpdater` implementing `DataUpdater` — iterates chains and assembles the config object |

Output file:

- `config/dolomite-margin.json` — `{ [chainId]: { dolomiteMargin, expiry, markets, depositWithdrawalProxy, borrowPositionProxy, genericTraderProxy } }`

The three proxy addresses (static, from `deployed.json`) feed the **calldata-sdk**
`DolomiteLending` / `DolomiteTrader` encoders, which take them as args; consumers
resolve them via `dolomiteConfigs()`.

`aggregatorTraders` (per-chain `IExchangeWrapper` addresses for `DolomiteTrader`
swaps/loops) are fetched live by [aggregators.ts](./aggregators.ts) from the
`dolomite-margin-modules` deployments file (they're not in `deployed.json`),
preferring the newest contract version per aggregator
(`odos`/`paraswap`/`oogabooga`/`enso`). Chains without a deployed aggregator
omit the field — base lending + position ops still work everywhere.

```jsonc
{
  "42161": {
    "dolomiteMargin": "0x6Bd780E7fDf01D77e4d475c821f1e7AE05409072",
    "expiry": "0xDEc1ae3b570ac3c57871BBD7bFeacC807f973Bea",
    "markets": { "0": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "1": "0xda10..." }
  }
}
```

## Merge semantics

`marketId`s are monotonic (governance only **adds** markets), so the updater uses
the standard deep-merge: new ids are appended, addresses stay put, diffs are
stable. A full re-read each run keeps the snapshot current as markets are added.

## Coverage notes

- **0-market chains** (BSC `56`, Superseed `5330`, Ink `57073`): DolomiteMargin
  is deployed at the shared CREATE2 address but no markets are initialized yet.
  They're kept in `DOLOMITE_DEPLOYMENTS` for a complete record and resolve to an
  empty `markets` map until governance adds markets — just re-run the updater.
- The chains with markets today: Arbitrum (75), Berachain (48), Ethereum (21),
  Mantle (16), Polygon zkEVM (9), X Layer (5), Botanix (5), Base (1).

## Run it

```bash
# all updaters
npm run update:dataset
# just Dolomite (one-off)
npx tsx -e "import('./src/data-manager.js').then(async ({DataManager})=>{const {DolomiteUpdater}=await import('./src/fetch/dolomite.js');const m=new DataManager();m.registerUpdater(new DolomiteUpdater());await m.updateFromSource('Dolomite',{});})"
```
