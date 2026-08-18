# Morpho-type vault names & curators — how they are sourced

The consumer (`margin-fetcher`'s `fetchMorphoVaults`) serves every MetaMorpho /
Vaults-V2 vault through one of **two paths**, and which path a chain takes is
decided by THIS repo's data:

| path | chains | name source | curator-name source |
|------|--------|-------------|---------------------|
| **Morpho API** (`blue-api.morpho.org`) | chains the API indexes (Ethereum, Base, Arbitrum, …) | API `vaults.name` | API `state.curators[].name` — authoritative, per vault |
| **On-chain registry** (`data/morpho-type-vaults.json`) | chains the API does NOT index (Robinhood 4663, Flare, Celo, Sei, Lisk, Soneium, TAC, Hemi, Kaia, Plume, …) | on-chain `name()`, falling back to the entry's `name` | the entry's `curatorName`, filled by `update:vault-curators` (below) |

**The routing rule is "registry entries exist ⇒ on-chain path".** Never add an
API-indexed chain to `data/morpho-type-vaults.json`: its presence would silently
flip that chain off the API path, losing the API's curators, rewards and
liquidity data. Conversely, a vault on a no-API chain that is missing from the
registry does not exist for consumers at all.

Verify a chain's API coverage before deciding where it belongs:

```bash
curl -s https://blue-api.morpho.org/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query { vaults(first: 5, where: { chainId_in: [<CHAIN>] }) { items { address } } }"}'
# empty items ⇒ no API coverage ⇒ registry chain
```

## 1. How vault entries (and their names) get into the registry

All jobs are **append-only** on `data/morpho-type-vaults.json` — entries are
never removed; a re-run refreshes `name` when the source disagrees.

| job | discovery | where the name comes from |
|-----|-----------|---------------------------|
| `update:onchain-vaults` | MetaMorpho v1 factories: `CreateMetaMorpho` events | the event itself carries `name` |
| | Vaults V2 factories: `CreateVaultV2` events | the event carries NO name — a follow-up batched `name()` read fills it |
| | `MANUAL_VAULTS` address lists (chains with no factory in config, e.g. Berachain) | on-chain `name()` |
| `update:feather-vaults` / `update:mystic-vaults` | hosted indexer APIs | the indexer's vault name |
| `update:lista-vaults` | Lista's indexer (fills the `LISTA_DAO` section, not `MORPHO_BLUE`) | the indexer's vault name |

Factories per chain live in `config/morpho-addresses.json`
(`metaMorphoFactory` for v1, `vaultV2Factory` for v2). A chain that has API
coverage, or is covered by the Feather/Mystic jobs, is skipped by
`update:onchain-vaults` automatically.

At fetch time the consumer prefers the **live on-chain `name()`** and uses the
registry `name` only as a fallback — so a stale registry name cannot mislabel a
live vault, and the registry name is what keeps a row legible when an RPC read
fails.

Each entry also carries `version: "v1" | "v2"` (detected via `adaptersLength()`
probing — see `src/fetch/morpho/vaultVersion.ts`), which drives the consumer's
allocation walk. Leave it unset only when detection failed; consumers then
auto-detect.

## 2. How curator names get into the registry — `update:vault-curators`

```bash
npm run update:vault-curators          # all chains in the file
npx tsx src/update-vault-curators.ts 4663   # one chain
```

No-API chains have no source that NAMES a curator — the chain yields only the
`curator()` **address** — so the job resolves names in three rungs, in
descending order of authority. A lower rung only ever fills a BLANK; nothing
ever clears a stored name:

1. **`MANUAL_CURATORS`** (script-local, chain → vault → name) — for curators no
   other source can know.
2. **The Morpho API's global curator roster** (`curators { addresses }`),
   joined on the vault's on-chain `curator()` / `owner()` address. Curator
   entities reuse the same addresses across chains — Steakhouse's Robinhood
   curator address appears in the roster under chain 1 — so the join works on
   chains the API does not index. Addresses claimed by more than one roster
   entity (B.Protocol / Block Analitica share several) are dropped as
   ambiguous rather than guessed. Roster hits DO refresh a stored name: the
   roster is the authority.
3. **A conservative parse of the vault's own name** ("Purinta USDG" →
   "Purinta"). Accepted only when the parse terminates on the asset symbol
   (read on-chain from the underlying) or a structural word ("Vault",
   "Savings", …) with tokens left over. A name consumed whole ("RHVault") is a
   vault name, not a curator, and yields nothing; test/fake vaults yield
   nothing. The same guards exist in `margin-fetcher`'s
   `curatorNameFromVaultName` — keep the two in sync.

Vaults the job cannot resolve simply keep no `curatorName`; consumers then fall
back to the "Morpho" brand. That is correct behavior, not a failure — add a
`MANUAL_CURATORS` row when the curator is actually known.

Run it **after** the vault-discovery jobs (it iterates whatever entries exist).

## 3. Publishing

Consumers load the **bundle first**. After any data change:

```bash
npm run build:bundle
```

then commit + merge — `initializer-sdk` fetches from this repo's `main` at
runtime.

The consumer type (`MorphoTypeVaultEntry` in `@1delta/data-sdk`) and the
on-chain fetcher (`margin-fetcher`'s `fetchMorphoVaultsFromChain`) carry
`curatorName` through to `MorphoVault.curatorName`; the earn surface renders it
as the row's brand. Changes on that side reach production only via an npm
publish + recorder re-ingest.

## 4. New-chain checklist

1. Confirm the chain is NOT indexed by the Morpho API (query above).
2. Add its factory address(es) to `config/morpho-addresses.json`
   (`metaMorphoFactory` and/or `vaultV2Factory`) — or a `MANUAL_VAULTS` list in
   `src/update-onchain-vaults.ts` if no factory is known.
3. `npx tsx src/update-onchain-vaults.ts <chainId>`
4. `npx tsx src/update-vault-curators.ts <chainId>`
5. `npm run build:bundle`, review the diff, PR.

## Related, but different

`data/morpho-curators.json` is per-**market** (lending) curator metadata for
API-covered chains — a different artifact serving the lending-market surface.
This document is about the **vault** registry only.
