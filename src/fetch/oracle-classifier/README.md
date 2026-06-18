# Oracle classification

Decodes each lender's price oracles down to their **actual on-chain source**,
classifies the **provider/type**, and matches the reported pair against the
**intended** asset. Produces a `data/<lender>-oracles-classified.json` per lender
in a shared, diffable schema modelled on `morpho-oracles-data.json`.

The raw oracle files (`*-oracles.json`, `*-oracle-sources.json`, etc.) only carry
the oracle address and, at best, a `description()` string. This layer answers the
questions those files can't:

- What is the oracle *actually* reading? (Chainlink aggregator? RedStone? a
  wrapper/adapter? a fixed rate? a composite of two feeds?)
- Does it price the **right asset**? (e.g. a market lists `USDe` but the feed
  reports `USDT / USD`)
- Is it denominated in the **right numeraire**? (e.g. a USD feed in an
  ETH-denominated market)

## Two-signal correctness model

Correctness is split into two **independent** booleans so a mixed-numeraire market
(legitimate, e.g. Aave V2 prices stables in USD and volatiles in ETH) doesn't drown
the real signal:

| Field | Question | `true` / `false` / `null` |
|---|---|---|
| `correctOracle` | Does the source price the **intended asset**? (numerator match, alias-aware) | matches / prices a different asset / unverifiable |
| `denominatorMatch` | Is it denominated in the protocol **numeraire**? (denominator match) | matches / cross-numeraire / unknown |

`null` means *unverifiable*: a constant/fixed-rate feed, an unresolved/composite
(`X * Y / Z`) description, or a missing symbol. Matching is wrapped-token- and
bridged-token-aware (`WBTC↔BTC`, `WETH↔ETH`, `MATIC↔POL`, `USDC.e↔USDC`, …) via
[`normalize.ts`](./normalize.ts).

## Architecture

A lender-agnostic **core** plus one thin **per-lender classifier** that supplies the
intended asset + numeraire.

### Shared core (`src/fetch/oracle-classifier/`)

| Module | Responsibility |
|---|---|
| [`abi.ts`](./abi.ts) | The battery of no-arg "pointer" selectors (`aggregator`, `underlyingPriceFeed`, `priceFeedA/B`, Morpho `BASE_FEED_*`, …) and "info" selectors (`description`, `decimals`, `getDataFeedId`) probed per node |
| [`normalize.ts`](./normalize.ts) | Description normalization (Chainlink / RedStone / Compound-wrapper / exchange-rate), `bytes32` decoding, and symbol-alias matching |
| [`feedResolver.ts`](./feedResolver.ts) | `probeFeedGraph()` — bounded-BFS walk of a feed's source graph; `resolveFeed()` — collapses it to a normalized pair + provider + `underlyingAggregator` + `sourcePath` |
| [`assess.ts`](./assess.ts) | `assessFeed()` — the two-signal correctness check; `dominantDenominator()` — derives a market's numeraire from its feeds |

`feedResolver` is where the unwrapping happens: starting from an oracle address it
follows every pointer selector (up to `maxDepth`), reading each node's
`description()`/`decimals()`/`getDataFeedId()`, then resolves a single reported pair —
collapsing wrappers (CAPO/SVR, scaling feeds), multiplicative composites
(`priceFeedA × priceFeedB`), Morpho-style `BASE/QUOTE` composites, and RedStone feed
IDs.

### Per-lender classifiers

Each reads that lender's raw metadata, runs the core, supplies the intended
asset/numeraire, and writes its classified file via a `DataUpdater`.

| Lender | Classifier | Output | Run |
|---|---|---|---|
| Compound v3 | [`compound-v3/classifyOracles.ts`](../compound-v3/classifyOracles.ts) | `data/compound-v3-oracles-classified.json` | `npm run update:compound-v3-oracles` |
| Aave v2/v3 + v4 | [`aave/classifyOracles.ts`](../aave/classifyOracles.ts) | `data/aave-oracles-classified.json`, `data/aave-v4-oracles-classified.json` | `npm run update:aave-oracles` |
| Euler | [`euler/classifyOracles.ts`](../euler/classifyOracles.ts) | `data/euler-oracles-classified.json` | `npm run update:euler-oracles` |
| Silo v2/v3 | [`silo/classifyOracles.ts`](../silo/classifyOracles.ts) | `data/silo-oracles-classified.json` | `npm run update:silo-oracles` |
| Fluid | [`fluid/classifyOracles.ts`](../fluid/classifyOracles.ts) | `data/fluid-oracles-classified.json` | `npm run update:fluid-oracles` |

Each `update:*` script registers the lender's `*OracleDataUpdater` (in
`src/fetch/<lender>-oracle-data.ts`) with the `DataManager`, which fetches and writes
the file. The updaters replace the file wholesale (no deep-merge) so stale
market/asset keys never linger.

## How each lender is decoded

The lenders differ in oracle architecture, so each classifier resolves the entry
point differently before handing off to the shared core.

- **Compound v3** — per-comet asset `priceFeed` (from `getAssetInfo`). Numeraire is
  the comet's pricing unit, derived from the **base token's feed denominator**
  (fallback: dominant denominator). Surfaces cross-numeraire collateral in WETH comets.
- **Aave v2/v3** — one `AaveOracle` per fork/chain; `getSourceOfAsset(asset)` gives
  each reserve's Chainlink-style source. Numeraire comes from `BASE_CURRENCY` when it
  is a real token, else the dominant feed denominator (legacy V2 is ETH-denominated and
  exposes no `BASE_CURRENCY()`).
- **Aave v4** — the pre-decoded `source` per underlying from
  `aave-v4-oracle-sources.json`, classified directly.
- **Euler** — `vault.oracle()` (an `EulerRouter`) +
  `vault.unitOfAccount()` (USD = sentinel `address(840)`). `getConfiguredOracle(asset,
  uoa)` → adapter, whose `name()` is the provider and whose `base()`/`quote()` give the
  end-to-end pair (`feed()` is the terminal aggregator).
- **Silo v2/v3** — each silo's `solvencyOracle`; `quoteToken()` is the numeraire,
  `oracle()`/`description()` the wrapped source where exposed.
- **Fluid** — `vaultResolver.getVaultEntireData(vault).configs.oracle`; intended pair
  is the vault's supply (collateral) / borrow (debt) underlyings.

## Output schema

Per lender the file is keyed `… → market/asset → entry`. Common fields:

```jsonc
{
  "oracle": "0x…",              // or source / adapter / router, per lender
  "assetSymbol": "WBTC",
  "provider": "chainlink",       // chainlink | redstone | compound-wrapper |
                                 // composite | constant | <EulerAdapter.name()> | …
  "rawDescription": "Custom price feed for WBTC / USD",
  "priceDescription": "WBTC / USD",   // normalized reported pair ("UNKNOWN" if undecodable)
  "underlyingAggregator": "0x…",      // deepest Chainlink aggregator, if any
  "sourcePath": [ { "address": "0x…", "description": "…", "kind": "chainlink" } ],
  "fixedRate": null,                  // true for hardcoded prices
  "intendedPair": "WBTC / USD",       // <assetSymbol> / <numeraire>
  "denominator": "USD",
  "correctOracle": true,              // numerator (asset) match
  "denominatorMatch": true            // denominator (numeraire) match
}
```

## Decode depth & limitations

- **Compound, Aave, Euler** decode to the underlying aggregator and verify both
  signals — these expose standard feed/adapter interfaces.
- **Silo, Fluid** are **wiring-level**: their oracles return config-driven exchange
  rates without a Chainlink-style pair `description()`, so most entries are
  `priceDescription: "UNKNOWN"` / `correctOracle: null`. They still capture the oracle
  address, provider, numeraire (Silo) and intended collateral/debt pair (Fluid). Deeper
  decoding would need per-oracle-type logic (e.g. Silo `oracleConfig()` aggregators).
- **Euler** leaves escrow vaults (no configured `(asset, uoa)` adapter) as `null`; a
  follow-up could resolve them via `getConfiguredOracle(vault, uoa)`.
- Fluid intentionally skips the deep BFS probe — its bespoke oracles expose many
  getters that explode the graph and hang the RPC.

## Adding a new lender

1. Create `src/fetch/<lender>/classifyOracles.ts` that enumerates
   `(market/asset, oracleEntryAddress, intendedAssetSymbol, numeraire)`, calls
   `probeFeedGraph()` + `resolveFeed()` per entry, then `assessFeed()`.
2. Add `src/fetch/<lender>-oracle-data.ts` implementing `DataUpdater`.
3. Add `src/update-<lender>-oracles.ts` registering it with `DataManager`.
4. Add `"update:<lender>-oracles"` to `package.json` scripts.
