# Aave V4 metadata generation

The Aave V4 fetcher discovers spokes, reserves, and oracles directly from
on-chain Hub contracts and emits the JSON files consumed by `lending-sdks`.
This document describes the on-disk shape of those files, how the fetcher
produces them, and how to add a new chain.

## Design: no fork dimension

A single Spoke contract can mix reserves backed by **different** Hubs.
`Reserve.hub` is set at reserve init in `Spoke.sol:146`, and every
borrow/supply/repay action routes through `reserve.hub.<x>(reserve.assetId, …)`
— the hub identity is **per-reserve**, not per-spoke and not per-fork.

For that reason none of the V4 metadata files carry a `AAVE_V4_CORE` /
`AAVE_V4_PLUS` / `AAVE_V4_PRIME` dimension. The spoke address is the
venue identity; the hub lives on each reserve. Synthesized lender keys are
of the form `AAVE_V4_<SPOKE_HEX>` (consumer side).

## Files produced

| File | Type | Shape |
|---|---|---|
| [`data/aave-v4-spokes.json`](../../../data/aave-v4-spokes.json) | data | `chain → spoke → SpokeEntry` (reserves nested) |
| [`data/aave-v4-oracles.json`](../../../data/aave-v4-oracles.json) | data | `chain → OracleRow[]` |
| [`data/aave-v4-oracle-sources.json`](../../../data/aave-v4-oracle-sources.json) | data | `chain → OracleSourceRow[]` |
| [`config/aave-v4-peripherals.json`](../../../config/aave-v4-peripherals.json) | config (manual) | `chain → { nativeGateway, signatureGateway, perHub, perSpoke }` |

There is no `aave-v4-reserves.json`, `aave-v4-reserve-details.json`, or
`aave-v4-hubs.json`. Reserve data lives inside each spoke entry. The hub
seed lives in [`v4Hubs.ts`](./v4Hubs.ts) (TS constant — build-only, not
shipped to consumers).

## Spoke entry shape

```jsonc
{
  "1": {
    "0x94e7a5dcbe816e498b89ab752661904e2f56c485": {
      "spoke":              "0x94e7a5dcbe816e498b89ab752661904e2f56c485",
      "oracle":             "0x99b2b6cea9c3d2fd8f4d90f86741c44b212a6127",
      "label":              "Main",
      "dynamicConfigKeyMax": 0,
      "baseHubAttribution": "AAVE_V4_CORE",
      "reserves": [
        {
          "reserveId":  0,
          "assetId":    0,
          "underlying": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          "hub":        "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9"
        }
      ]
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| top-level key | yes | chainId as decimal string |
| second-level key | yes | spoke address, lowercase, `0x`-prefixed |
| `spoke` | yes | duplicate of the key, kept for ergonomics in array iteration |
| `oracle` | yes | spoke-level oracle (lowercase, may be `""` for inactive spokes) |
| `label` | yes | UI label, free-form |
| `dynamicConfigKeyMax` | yes | max `dynamicConfigKey` across the spoke's reserves; consumers enumerate `0..N` |
| `baseHubAttribution` | yes | cosmetic UI hint (`"AAVE_V4_CORE"` / `_PLUS` / `_PRIME`); **never** used for routing |
| `reserves` | yes | one entry per reserve in the spoke |
| `reserves[].reserveId` | yes | spoke-internal reserve id |
| `reserves[].assetId` | yes | hub-internal asset id (scoped to `reserves[].hub`) |
| `reserves[].underlying` | yes | underlying ERC-20 (lowercase) |
| `reserves[].hub` | yes | per-reserve hub address — the canonical routing target. Read from `Spoke.getReserve(reserveId).hub` |

## Oracle row shape

```jsonc
{
  "1": [
    {
      "underlying": "0x...",
      "spoke":      "0x...",
      "reserveId":  0,
      "oracle":     "0x..."
    }
  ]
}
```

`aave-v4-oracle-sources.json` has the same shape with two extra fields:
`decimals` (uint8, defaults to `8`) and `source` (per-reserve Chainlink feed).

Rows are unique by `(spoke, reserveId)` within a chain.

## Peripherals shape

```jsonc
{
  "1": {
    "nativeGateway":    "0x...",
    "signatureGateway": "0x...",
    "perHub": {
      "0x<hub-core>":  { "nativeGateway": "0x...", "signatureGateway": "0x..." },
      "0x<hub-plus>":  { "nativeGateway": "0x...", "signatureGateway": "0x..." },
      "0x<hub-prime>": { "nativeGateway": "0x...", "signatureGateway": "0x..." }
    },
    "perSpoke": {
      "0x<spoke>": {
        "spokeName":       "Main",
        "spokeId":         "...",
        "positionManagers": [{ "name": "...", "address": "0x...", "active": true }]
      }
    }
  }
}
```

- `nativeGateway` / `signatureGateway` at the chain level are **fallbacks**
  used when `perHub` has no entry for the requested hub.
- `perHub` keys are **lowercase** hub addresses with `0x` prefix.
- `perSpoke` is curated UI metadata (spoke names, position managers). It is
  not auto-generated and is not used for routing.

## Generation pipeline

The fetcher runs in three RPC stages, all chain-scoped (no fork dimension):

```
v4Hubs.ts (TS constant)
        |
        v
  fetchV4Configs   ──► chain → spoke → { spoke, oracle, label, baseHubAttribution }
        |              (dedup'd across hubs that reference the same spoke)
        v
  fetchV4Reserves  ──► chain → spoke → ReserveDetail[]
        |              (per-reserve hub from getReserve(rid).hub on-chain;
        |               also fetches getReserveConfig and the latest dynamic config)
        v
  fetchV4Oracles   ──► chain → OracleRow[] / OracleSourceRow[]
                       (oracle decimals + per-reserve Chainlink sources)
```

The `AaveV4Updater` class in [`../aave-v4.ts`](../aave-v4.ts) orchestrates
the three stages, builds the consolidated `SpokesJson`, and ships it
through the `DataManager`.

### Multicall failure handling

- `fetchV4Reserves` runs up to two retry rounds for any `getReserve(rid)`
  slot that came back empty — common when a multicall partially fails.
- `fetchV4Oracles` retries individual `getReserveSource(rid)` slots that
  returned the `"0x"` failure sentinel.
- The merge layer in `aave-v4.ts` is **append-only**: an empty oracle from
  a flaky run will not wipe a previously-written valid one. Same for
  `underlying`, `hub`, and `source` fields.

## Adding a new chain or hub

1. Edit [`v4Hubs.ts`](./v4Hubs.ts) — add an entry under the chain id with
   the hub address and an `attribution` label.
2. (Optional) Add gateway addresses to
   [`config/aave-v4-peripherals.json`](../../../config/aave-v4-peripherals.json)
   under the new chain — set the chain-level `nativeGateway`/
   `signatureGateway` fallbacks and a `perHub` entry per hub.
3. Run the dataset update:
   ```bash
   npm run update:dataset
   ```
   (This runs every registered updater. To run only Aave V4 you can call
   `manager.updateFromSource("Aave V4")` from a small script — see
   `update-dataset.ts`.)
4. Verify the new entries in `data/aave-v4-spokes.json`.

## Validation checklist

Run these checks before publishing the new files:

1. Every spoke key matches `^0x[0-9a-f]{40}$` (lowercase, no upper hex).
2. Every reserve has a `hub` field that matches `^0x[0-9a-f]{40}$`.
3. `reserves[i].hub` agrees with `Spoke.getReserve(reserveId).hub` on-chain
   — that is the canonical source of truth.
4. `(reserves[i].assetId, reserves[i].hub)` resolves on-chain via
   `hub.getAsset(assetId)` to a struct whose `underlying` matches
   `reserves[i].underlying`.
5. No spoke appears twice within the same chain object.
6. Every spoke listed in `data/aave-v4-oracles.json` also exists in
   `data/aave-v4-spokes.json` for the same chain.
7. Distinct hubs per spoke ≤ 3 (soft cap — the consumer fetcher caps hub
   enumeration cost; bump it if a spoke ever needs more).
8. Every hub address in any `reserves[].hub` has an entry in
   `config/aave-v4-peripherals.json` `perHub` for the same chain (or the
   chain-level fallback gateways are correct for it).

## Consumer-side notes (lending-sdks)

For context — these don't affect the metadata repo:

- `data-sdk` exposes `aaveV4Spokes()` only; reserve data is read from
  `spokes[chainId][spoke].reserves`. No `aaveV4Hubs()` / `aaveV4Reserves()`.
- `aaveV4SpokeLenderKey(spokeAddr) → "AAVE_V4_<SPOKE_HEX>"`.
- `margin-fetcher` walks `aaveV4Spokes()[chainId]` once per chain and
  resolves each reserve's hub via `reserves[i].hub` directly.
- `getAaveV4GatewayAddresses(chainId, lender)` resolves the spoke from the
  lender key, picks any reserve's hub, and looks up
  `peripherals[chainId].perHub[hub]` (with chain-level fallback if unset).
