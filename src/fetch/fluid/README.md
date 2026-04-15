# Fluid updater

Snapshots Fluid's on-chain vault state into `data/fluid-vaults.json` (keyed by
chainId → vault address) and appends per-vault labels to
`data/lender-labels.json`. Registered in [update-dataset.ts](../../update-dataset.ts)
as `FluidUpdater`.

## Why Fluid needs less metadata than Aave/Morpho

Fluid's resolvers are introspective: `vaultResolver.getAllVaultsAddresses()`
and `lendingResolver.getAllFTokens()` return everything in one call. The
metadata repo only needs to store **resolver addresses per chain** — the vault
snapshot exists so consumers can:

1. **Chunked-fetch fallback** — iterate the cached vault addresses and call
   `getVaultEntireData(vault)` per address when the single `getVaultsEntireData()`
   call exceeds gas limits on busy chains.
2. **Vault ↔ fToken link** — each vault side carries a denormalized `fToken`
   address per underlying, resolved at snapshot time, so consumers don't need
   a separate fToken index. See [PLAN.md](./PLAN.md) (§1.3).

The fToken list itself is **not written** to a JSON file — consumers can read
it live from `lendingResolver.getAllFTokens()` + the fToken ERC20 getters. The
only persisted use of fTokens is the denormalized `assets[].fToken` link on
each vault side.

## File layout

| File | Purpose |
| --- | --- |
| [abi.ts](./abi.ts) | Minimal ABIs: `getAllVaultsAddresses`, `getVaultEntireData`, `getAllFTokens`, fToken `asset/symbol/isNativeUnderlying` |
| [constants.ts](./constants.ts) | Loads `config/fluid-resolvers.json`; exports `FLUID_LENDING` / `FLUID_VAULT` key prefixes |
| [fetcher.ts](./fetcher.ts) | Multicall helpers — vault/fToken address lists, per-entity metadata, underlying→fToken index, `buildSide` decoder |
| [fluid.ts](./fluid.ts) | `FluidUpdater` implementing `DataUpdater` — also fetches the 1delta token-list for label generation |

Output files:

- `config/fluid-resolvers.json` — source-of-truth resolver addresses per chain
- `data/fluid-vaults.json` — `{ [chainId]: { [vaultAddr]: VaultMeta } }` (schema below)
- `data/lender-labels.json` — merged `FLUID_LENDING` + per-vault `FLUID_VAULT_<vaultId>` labels

### Vault schema

Every vault has a `supply` and a `borrow` side with uniform shape across T1–T4.
Each side holds a single `assets` array — one entry per underlying, each
carrying its own `fToken` link:

```jsonc
{
  "vaultId": 1,
  "type": 10000,                                 // raw TYPE() — 10000/20000/30000/40000 for T1/T2/T3/T4
  "supply": {
    "dex":          null,                        // DEX pool address for smart sides, else null
    "smartLending": null,                        // optional SmartLending wrapper; not captured (always null here)
    "assets": [
      { "underlying": "0x<token>", "fToken": "0x<fToken>" | null }
    ]
  },
  "borrow": { /* same shape */ }
}
```

`side.assets.length > 1` ⇔ smart side (T2/T4 supply, T3/T4 borrow); equivalent
to `side.dex !== null`. Consumers iterate `side.assets.map(a => ...)` — one
code path regardless of vault type. Adding per-asset fields later extends the
asset object without schema churn.

`smartLending` is always `null` — the SmartLending wrapper is not exposed by
`ConstantViews`, and detecting it requires an external source.

### Label format

The dynamic lender key for a vault is `FLUID_VAULT_<vaultId>` — matching how
the runtime parser in the consumer SDK constructs keys (`FLUID_VAULT_${vaultId}`
in `publicCallParse.ts`). The human-readable label is Morpho-style:

```
Fluid <supplySymbols>-<borrowSymbols>[ N]
```

- **Symbols** come from the 1delta token-list
  (`https://raw.githubusercontent.com/1delta-DAO/token-lists/main/{chainId}.json`),
  same source the Morpho updater uses.
- **Smart sides** join their two underlyings with `+` — e.g.
  `Fluid WETH+wstETH-USDC` (T2), `Fluid WETH+wstETH-USDC+USDT` (T4).
- **Native ETH** (Fluid sentinel `0xEeee…`) renders as `ETH`.
- **Unknown tokens** fall back to the short address prefix (`0x1234…`).
- **Duplicate pairs** — when several vaults share the same `supply-borrow`
  string (e.g. multiple LTV tiers of `WETH-USDC`), the first (lowest vaultId)
  keeps the plain label and subsequent ones get ` 2`, ` 3`, … appended.

## Fetch flow

For each chain in `FLUID_RESOLVERS`:

1. `getAllVaultsAddresses()` + `getAllFTokens()` + token-list fetch in parallel.
2. Per fToken: `asset() + symbol() + isNativeUnderlying()` batched in one multicall.
3. Build the `underlying → fToken` index from the fToken metas.
4. Per vault: `vaultResolver.getVaultEntireData(vault)` batched in one multicall.
   Pull `vaultId`, `vaultType`, and `constantVariables.{supplyToken,borrowToken,supply,borrow}`.
   Decode each side with `buildSide`, denormalising the fToken link against the index.
5. Sort vaults by `vaultId` and emit labels — deterministic ` N` suffix ordering.
6. 500 ms sleep between chains to avoid RPC rate limits.

Per-chain failures are logged and skipped.

## Adding a new chain

1. Append an entry to [config/fluid-resolvers.json](../../../../config/fluid-resolvers.json).
   Resolver addresses are currently **identical across chains**, but the
   per-chain structure lets a divergent deployment slot in without code changes.
2. Re-run `npm run update:dataset`. Vaults get populated automatically.

Supported chains track
[fluid-contracts-public/deployments.md](https://github.com/instadapp/fluid-contracts-public/blob/main/deployments/deployments.md).

## Known limitations / follow-ups

- **`smartLending`** — always emitted as `null`. Populate from an off-chain
  source (Fluid API or a hardcoded map) if/when consumers need it.
- **Merkle/campaign rewards** — come from `https://api.fluid.instadapp.io/v2/...`,
  not on-chain. Intentionally not cached here (dynamic).
- **Lender enum** — `@1delta/lender-registry` has no `FLUID_LENDING` /
  `FLUID_VAULT` constants yet. The updater uses string literals; swap for enum
  refs once upstream adds them.
- **Chunked fallback on large chains** — snapshot uses `getVaultEntireData`
  per-vault via multicall, which already chunks naturally. If the multicall
  response itself hits limits, split `vaults` into batches in `getVaultMetas`.
- **Stale keys** — if the label schema changes (e.g. switching from
  address-keyed to vaultId-keyed), old entries are not auto-pruned from
  `lender-labels.json` because `mergeData` is additive. Clean up manually when
  the schema changes.
