# Morpho vaults with a stub (DummyERC20) underlying

Probed 246 unique underlyings behind 3147 vaults on 34 chains (2026-09-14): every vault in `data/morpho-type-vaults.json` (MORPHO_BLUE + LISTA_DAO, the non-API chains) plus the 2,996 Morpho-API vaults known to risk-data (`vault-allocations.json`).

Result: **17 stubs, all the same artifact** — a 129-byte `DummyERC20` (identical bytecode on every chain, keccak `0x9c7619a2bb38fa84…`) that implements only `approve()` (returns true) and `decimals()` (returns 0). `name`, `symbol`, `totalSupply`, `balanceOf`, `transfer` all revert. Each is the asset of exactly one nameless, empty MetaMorpho v1 vault — the factory smoke-test (stub token + vault deployed in one tx). **Zero stubs among the 2,996 Morpho-API vaults**; all 17 come from the Feather / event-scan catalogue.

Not flagged (verified as real ERC20s behind small proxies, not stubs): USDS/sUSDS, RLUSD, wM, wUSDL, EURe, XAUM, scrvUSD, apxUSD, USDH, USDG, uSOL, pUSD, BUSD, ASTR, WETH (Monad), etc. — 45–300 B EIP-1167 / ERC1967 proxies whose `name/symbol/totalSupply` all answer. Tempo's pathUSD precompile (1 B of code) also answers. Arc (5042) could not be probed (no viem chain in `@1delta/providers`).

| chain | vault | underlying (DummyERC20) | vault name | totalAssets |
|---|---|---|---|---|
| 14 Flare | `0x5eae7e544258e421cb2774e508e15ee8dade8200` | `0x1702633bd12a03e8ea6fde795a3ecf0d3725b4e1` | ∅ | ? |
| 146 Sonic | `0xd7f2f89e1991de2b9d62fbeeeb3bc0b01d032328` | `0xf1e71beb3565f6bb7529e40dbd4469d8722f06bf` | ∅ | 0 |
| 239 TAC | `0x2903a9e55bb8a05e6cbdd5c5d00203bf527fa9db` | `0xcf03b0b1abe1eefdfbeeabcfd3fc3e8ba6648015` | ∅ | 0 |
| 1135 Lisk | `0x389724731cea95c4a46cc93e96f211f389f31405` | `0x5948d0849e691e304b45a36d34cb8c4d7b0093c9` | ∅ | 0 |
| 1672 Pharos | `0x79ded579756072372510ff3a86f884433a697b5c` | `0x107b8999eec91f2beeaaece0c811f91b54ecdb85` | ∅ | ? |
| 1868 Soneium | `0x94665e0df3c8c25119d80b2e3c703ccd127bf37e` | `0x7b6315379faf4379bb22c121309813c4b63e5430` | ∅ | 0 |
| 2741 Abstract | `0x225c6e63970bb04d0780b3abb047dba659ad3cec` | `0xb941a54fabaf6cf3f91372c3042a5f94706892e5` | ∅ | 0 |
| 2818 Morph | `0x7cf2c1a184c2f17e0413a13b21b1fdafd51df08c` | `0x2346878c739487b121490b4bea53e12a078725e6` | ∅ | ? |
| 4114 Citrea | `0xc063aca30b0d56ff0a9e446a94f8cdb421ab89fb` | `0xefd1e95211adb15de3762b5b595769c767de51f2` | ∅ | ? |
| 4326 MegaETH | `0xf55c695ebaf1f4eefeda0833ef6a29c90e7b7f05` | `0x838ac89cb0734f16977b00ba4995f17518df69c7` | ∅ | ? |
| 34443 Mode | `0xf4461806c58d9e7cd74e79b113d81d127634b807` | `0xaf00a193c4b96764ab03bffee12689b90a4019ab` | ∅ | 0 |
| 42220 Celo | `0x099272b39ae8e6d7d415e8ba252c3d2c59432087` | `0xb386316a5a6d2090deaf1004ae92f7ef976d014d` | ∅ | 0 |
| 43111 Hemi | `0x339b3b6413345b4d3beb524c12cd3910c6dd8dbb` | `0xcd556db60203d02d1004a2a98fc65f8efebf792b` | ∅ | 0 |
| 57073 Ink | `0xb00123b1058c13559408b9d609ed417617f588ed` | `0xedf3ac5ed52495ed160d9125ab2d8a9682f283dd` | ∅ | 0 |
| 59144 Linea | `0x3e89134a270b8f0dc3dfd8bf6e249fddb2f7a634` | `0x8985e6da757b2eb714131f999050c586ef50f274` | ∅ | 0 |
| 98866 Plume | `0x6f8acb9c03abb7ba6ba24b4698b019ffe96eae60` | `0x111208b9d12822630e343363ef44192843a73984` | ∅ | 0 |
| 98866 Plume | `0xd2586890224ab02bf31334e15872cd9c93f68ba8` | `0xae83e5bd2b9925792205051bed32de8e0747779b` | ∅ | ? |

Machine-readable: `data/morpho-stub-vaults.json`. Regenerate: `pnpm exec tsx src/audit-vault-underlyings.ts [--out report.json] [extra-vaults.json]`.

## Resolution (2026-09-14)

- **Purged**: all 17 rows above are removed from `data/morpho-type-vaults.json` (Linea 59144 is left as an empty list — the smoke-test was its only catalogued vault). `inCatalogue` in the JSON is now `false` on every row.
- **Guarded**: every job that appends to the catalogue — `update:feather-vaults`, `update:onchain-vaults` (v1 + v2 factory scans and the manual list), `update:mystic-vaults`, `update:lista-vaults` — runs its candidates through `dropStubUnderlyings` (`src/fetch/morpho/stubUnderlying.ts`) before the append-only merge, so the next run cannot re-add them. The audit script imports the same classifier from that module, so the rule cannot drift between the guard and the report.
- **The rule**: an underlying is a stub when `totalSupply()` reverts, or `name()` AND `symbol()` both revert / answer empty. Bytecode size is never decisive. The guard fails OPEN — an unreachable chain, or two-or-more distinct underlyings ALL reading as stubs (an RPC answering nothing), leaves the chain unfiltered with a warning; a chain whose single underlying is the stub is still filtered (verified live on Linea and on Citrea, whose multicall answers `0x` and needs the direct-`eth_call` fallback).
- **`find-missing-tokens`** reads the catalogue, so with the rows gone it no longer offers the 17 dummies to the token-list pipeline; nothing there needed changing.
- Verified live on all 16 affected chains: with the stub re-injected next to the real catalogue vaults, the guard dropped exactly the stub and kept every real vault (Plume: 17 real kept, 2 stubs dropped). Re-running the audit over the purged catalogue reports `ok: 76`, zero flagged.

## Deleting what is already recorded downstream (2026-09-14)

Checked every sibling store for the 34 addresses (17 vaults + 17 underlyings):
`token-lists` — none (the dummies were never added); `risk-data` — none;
`lending-owners` — none. **yield-tracer production DOES hold 11 of the 17** as
`provider = 'morpho'` rows in `vaults_latest` (served on `/vaults/latest`, name
and symbol empty, TVL 0; absent from `/earn/latest` only because of its TVL
floor): chains 14, 146, 1135, 1672, 1868, 2818, 42220, 43111, 59144 and both
Plume vaults. The other six (239, 2741, 4114, 4326, 34443, 57073) were never
ingested. Ingestion is upsert-only, so they stay until deleted by hand.

**Belt and braces on the fetcher side**: margin-fetcher's on-chain vault path
refuses these 17 BY VAULT ADDRESS (`vaults/morpho/stubVaults.ts`, a per-chain
list — the dummy token itself is not blacklisted, nothing else references it),
pinned by `test/vaults/morpho/morphoStubVaults.test.ts`. So even a stale
published bundle cannot re-insert a deleted row once that margin-fetcher
version is on the sweep. A NEW chain's smoke-test vault is caught by the
registry guard; if it ever slips through, add its address to that list.

Adminer, once the guarded margin-fetcher is on the fetcher boxes:

```sql
-- the 17 (chain_id, vault) pairs
WITH stub(chain_id, vault) AS (VALUES
  ('14','0x5eae7e544258e421cb2774e508e15ee8dade8200'),
  ('146','0xd7f2f89e1991de2b9d62fbeeeb3bc0b01d032328'),
  ('239','0x2903a9e55bb8a05e6cbdd5c5d00203bf527fa9db'),
  ('1135','0x389724731cea95c4a46cc93e96f211f389f31405'),
  ('1672','0x79ded579756072372510ff3a86f884433a697b5c'),
  ('1868','0x94665e0df3c8c25119d80b2e3c703ccd127bf37e'),
  ('2741','0x225c6e63970bb04d0780b3abb047dba659ad3cec'),
  ('2818','0x7cf2c1a184c2f17e0413a13b21b1fdafd51df08c'),
  ('4114','0xc063aca30b0d56ff0a9e446a94f8cdb421ab89fb'),
  ('4326','0xf55c695ebaf1f4eefeda0833ef6a29c90e7b7f05'),
  ('34443','0xf4461806c58d9e7cd74e79b113d81d127634b807'),
  ('42220','0x099272b39ae8e6d7d415e8ba252c3d2c59432087'),
  ('43111','0x339b3b6413345b4d3beb524c12cd3910c6dd8dbb'),
  ('57073','0xb00123b1058c13559408b9d609ed417617f588ed'),
  ('59144','0x3e89134a270b8f0dc3dfd8bf6e249fddb2f7a634'),
  ('98866','0x6f8acb9c03abb7ba6ba24b4698b019ffe96eae60'),
  ('98866','0xd2586890224ab02bf31334e15872cd9c93f68ba8'))
-- preview first:
-- SELECT v.* FROM vaults_latest v JOIN stub s ON s.chain_id = v.chain_id AND s.vault = lower(v.vault_address) WHERE v.provider = 'morpho';
, d1 AS (DELETE FROM vaults_snapshots v USING stub s
           WHERE v.provider = 'morpho' AND s.chain_id = v.chain_id AND s.vault = lower(v.vault_address) RETURNING 1)
, d2 AS (DELETE FROM vault_risks v USING stub s
           WHERE v.provider = 'morpho' AND s.chain_id = v.chain_id AND s.vault = lower(v.vault_address) RETURNING 1)
, d3 AS (DELETE FROM earn_name_suffix n USING stub s
           WHERE n.earn_uid = 'vault.morpho:' || s.chain_id || ':' || s.vault RETURNING 1)
, d4 AS (DELETE FROM vaults_latest v USING stub s
           WHERE v.provider = 'morpho' AND s.chain_id = v.chain_id AND s.vault = lower(v.vault_address) RETURNING 1)
SELECT (SELECT count(*) FROM d1) AS snapshots, (SELECT count(*) FROM d2) AS risks,
       (SELECT count(*) FROM d3) AS name_suffix, (SELECT count(*) FROM d4) AS latest;
-- vault_morpho_meta cascades from vaults_latest; mv_earn_latest drops them on its next refresh.
```
