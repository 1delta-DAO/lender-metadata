# Lender Metadata

On-chain fetchers for DeFi lending protocol metadata. Each fetcher performs batched multicalls to collect reserve, token, and oracle data, then writes structured JSON files to `data/` and `config/`.

## Fetchers

All fetchers live in `src/fetch/` and implement the `DataUpdater` interface, returning `{ filePath: data }` maps.

### Aave V2/V3 (`src/fetch/aave/`)

Covers Aave V2, Aave V3, and forks (Lendle, Meridian, Aurelius, ZeroLend, LayerBank V3, etc.).

| File | Description |
|------|-------------|
| `data/aave-tokens.json` | Reserve token addresses (aToken, sToken, vToken) per underlying |
| `data/aave-reserves.json` | List of underlying reserve addresses |
| `data/aave-oracles.json` | Oracle contract address per fork/chain |
| `config/aave-pools.json` | Pool and ProtocolDataProvider addresses |
| `config/aave-weth-gateway.json` | WrappedTokenGateway (native-token wrapper) per fork/chain |

`aave-weth-gateway.json` is hand-maintained. `node scripts/discover-weth-gateways.mjs verify`
re-checks every entry on-chain (`getWETHAddress()` plus the gateway's unlimited allowance on
its market's Pool); `... discover [--logs] [chainId ...]` looks for the gateways still missing
for markets in `config/aave-pools.json` and prints a JSON block to merge.

**`aave-tokens.json`** — derivative token mapping:
```json
{
  "AAVE_V3": {
    "1": {
      "0x<underlying>": {
        "aToken": "0x...",
        "sToken": "0x...",
        "vToken": "0x..."
      }
    }
  }
}
```

**`aave-reserves.json`** — flat address lists:
```json
{
  "AAVE_V3": {
    "1": ["0x...", "0x..."]
  }
}
```

**`aave-oracles.json`**:
```json
{
  "AAVE_V3": {
    "1": "0x..."
  }
}
```

---

### Aave V4 (`src/fetch/aave-v4.ts`, `src/fetch/aave/fetchV4*.ts`)

Covers Aave V4 hubs, spokes, reserves, and oracles (Core, Plus, Prime).

| File | Description |
|------|-------------|
| `config/aave-v4-hubs.json` | Hub contract addresses per fork/chain (seed config) |
| `config/aave-v4-peripherals.json` | Chain-level gateways and per-spoke position managers (from Aave Kit GraphQL) |
| `data/aave-v4-spokes.json` | Discovered spoke addresses with oracle per hub |
| `data/aave-v4-reserves.json` | Reserve ID lists per spoke |
| `data/aave-v4-reserve-details.json` | Reserve details (underlying, decimals, borrowable, etc.) |
| `data/aave-v4-oracles.json` | Oracle entries per reserve (array format) |
| `data/aave-v4-oracle-sources.json` | Oracle sources with decimals per reserve (array format) |

**`aave-v4-hubs.json`** — seed config:
```json
{
  "AAVE_V4_CORE": {
    "1": { "hub": "0x..." }
  }
}
```

**`aave-v4-spokes.json`** — discovered spokes (sorted by spoke address):
```json
{
  "AAVE_V4_CORE": {
    "1": [
      {
        "spoke": "0x...",
        "oracle": "0x...",
        "label": "Spoke 0x1234..abcd",
        "dynamicConfigKeyMax": 2
      }
    ]
  }
}
```

**`aave-v4-oracles.json`** — one entry per reserve (sorted by spoke, then reserveId):
```json
{
  "AAVE_V4_CORE": {
    "1": [
      {
        "underlying": "0x...",
        "spoke": "0x...",
        "reserveId": 0,
        "oracle": "0x..."
      }
    ]
  }
}
```

**`aave-v4-oracle-sources.json`** — includes decimals and source per entry:
```json
{
  "AAVE_V4_CORE": {
    "1": [
      {
        "underlying": "0x...",
        "spoke": "0x...",
        "reserveId": 0,
        "oracle": "0x...",
        "decimals": 8,
        "source": "0x..."
      }
    ]
  }
}
```

**Consumer notes:**

- **Entries may have `"oracle": "0x"`** — this means the spoke's oracle is not yet configured on-chain (common for newly deployed pools like PRIME). Consumers should treat `"0x"` as "oracle unavailable" and handle accordingly. When the oracle becomes available on-chain, it will be populated on the next fetch run.
- **Entries may have `"underlying": ""`** — same reason; the reserve exists but returned empty data from the RPC. The entry is included to ensure the reserve set is complete.
- **Append-only merge** — oracle and spoke data uses append-only merge logic. Existing entries with valid oracle addresses are never overwritten by `"0x"` (protects against transient RPC failures). New reserves are always added.
- **Composite key** — each oracle entry is uniquely identified by `(underlying, spoke, reserveId)`. Consumers should use this tuple for deduplication.
- **Stable ordering** — spokes are sorted by address; oracle entries are sorted by spoke address then reserveId. This produces minimal diffs across runs.

---

### Compound V2 (`src/fetch/compound-v2/`)

Covers Compound V2 forks (Benqi, Venus, OVix, Granary, Unitus, etc.).

| File | Description |
|------|-------------|
| `data/compound-v2-c-tokens.json` | underlying → cToken address map |
| `data/compound-v2-tokens.json` | Array of `{ cToken, underlying }` pairs |
| `data/compound-v2-reserves.json` | List of underlying reserve addresses |
| `data/compound-v2-oracles.json` | Oracle contract address per fork/chain |
| `config/compound-v2-pools.json` | Comptroller addresses |

**`compound-v2-c-tokens.json`** — object mapping:
```json
{
  "VENUS": {
    "56": {
      "0x<underlying>": "0x<cToken>"
    }
  }
}
```

**`compound-v2-tokens.json`** — array format:
```json
{
  "VENUS": {
    "56": [
      { "cToken": "0x...", "underlying": "0x..." }
    ]
  }
}
```

---

### Compound V3 (`src/fetch/compound-v3/`)

Covers Compound V3 (Comet) markets — USDC, USDT, WETH, WBTC, etc.

| File | Description |
|------|-------------|
| `data/compound-v3-base-data.json` | Base asset address and minimum borrow amount |
| `data/compound-v3-reserves.json` | Collateral asset addresses (base asset first) |
| `data/compound-v3-oracles.json` | Oracle address per asset within each comet |
| `config/compound-v3-pools.json` | Comet contract addresses |

**`compound-v3-base-data.json`**:
```json
{
  "COMPOUND_V3_USDC": {
    "1": {
      "baseAsset": "0x...",
      "baseBorrowMin": "1000000000000000000"
    }
  }
}
```

**`compound-v3-oracles.json`** — per-asset oracle mapping:
```json
{
  "COMPOUND_V3_USDC": {
    "1": {
      "0x<asset>": "0x<oracle>"
    }
  }
}
```

---

### Euler (`src/fetch/euler/`)

Covers Euler V2 vaults across 20+ chains.

| File | Description |
|------|-------------|
| `data/euler-vaults.json` | Vault → underlying asset pairs |
| `config/euler-configs.json` | EVC, factory, lens, and protocol addresses |

**`euler-vaults.json`**:
```json
{
  "EULER_V2": {
    "1": [
      { "underlying": "0x...", "vault": "0x..." }
    ]
  }
}
```

**`euler-configs.json`**:
```json
{
  "EULER_V2": {
    "1": {
      "evc": "0x...",
      "eVaultFactory": "0x...",
      "protocolConfig": "0x...",
      "vaultLens": "0x...",
      "accountLens": "0x...",
      "oracleLens": "0x...",
      "irmLens": "0x...",
      "utilsLens": "0x..."
    }
  }
}
```

---

### Init (`src/fetch/init/`)

Covers Init lending protocol on Mantle and Blast.

| File | Description |
|------|-------------|
| `data/init-config.json` | Pool entries with underlying asset and supported modes |
| `config/init-pools.json` | Pool config contract addresses |

**`init-config.json`**:
```json
{
  "INIT": {
    "5000": [
      {
        "pool": "0x...",
        "underlying": "0x...",
        "modes": [1, 2, 3]
      }
    ]
  }
}
```

---

### Morpho (`src/fetch/morpho/`)

Covers Morpho Blue and Lista DAO markets. Fetches from both on-chain calls and Goldsky subgraphs.

**Vault names & curators** — how `data/morpho-type-vaults.json` is populated
(API-vs-registry routing, the discovery jobs, and the `update:vault-curators`
resolution rungs) is documented in
**[`MORPHO_VAULT_NAMES.md`](MORPHO_VAULT_NAMES.md)**.

| File | Description |
|------|-------------|
| `data/lender-labels.json` | Human-readable names and short names for all markets |
| `data/morpho-type-oracles.json` | Oracle info with loan/collateral asset decimals |
| `data/morpho-curators.json` | Curator metadata (name, image, verified status) per market |
| `config/morpho-pools.json` | Morpho Blue contract addresses |
| `config/morpho-type-markets.json` | Market IDs (bytes32 hashes) |

**`lender-labels.json`** — display names:
```json
{
  "names": {
    "MORPHO_USDC_WETH_86": "Morpho USDC-WETH 86%"
  },
  "shortNames": {
    "MORPHO_USDC_WETH_86": "MB USDC-WETH 86%"
  }
}
```

**`morpho-type-oracles.json`**:
```json
{
  "1": {
    "MORPHO_BLUE": [
      {
        "oracle": "0x...",
        "loanAsset": "0x...",
        "collateralAsset": "0x...",
        "loanAssetDecimals": 6,
        "collateralAssetDecimals": 18
      }
    ]
  }
}
```

**`morpho-curators.json`**:
```json
{
  "1": {
    "MORPHO_USDC_WETH_86": [
      {
        "id": "0x...",
        "image": "https://...",
        "verified": true,
        "name": "Curator Name"
      }
    ]
  }
}
```

---

### Lista collateral providers (`src/update-lista-collateral-providers.ts`)

| File | Description |
|------|-------------|
| `data/lista-providers.json` | Chain-level native (WBNB/WETH) provider |
| `data/lista-collateral-providers.json` | **Shape** of every per-market collateral provider |

Moolah gates collateral behind a per-market provider (`providers(id, collateral)`):
when set, only that contract may supply/withdraw. Two incompatible shapes exist and
nothing on-chain announces which is which —

- `erc20` / `native` — forwards Moolah's own selectors (`0x238d6579` /
  `0x8720316d`) and takes the collateral token itself;
- `smart-lp` — Lista's `SmartProvider`, which zaps a two-coin StableSwap pool:
  `supplyCollateral(mp, onBehalf, amount0, amount1, minLp)` and friends. Its
  collateral receipt is `onlyMoolah`-transferable, so the real deposit inputs are
  the **pool coins**, never the collateral token.

Encoding one shape for the other reverts with empty data, so consumers look the
provider up here and **fail closed** on an address they do not know.

Only immutable wiring is stored (`TOKEN` is a constructor immutable; `dex` /
`dexInfo` / `dexLP` are `initialize`-only; pool `coins` and their decimals never
move). Prices, virtual price and balances are runtime reads. The market → provider
mapping is deliberately **absent** — the Lista lens already returns
`collateralProvider` per market, so only a NEW PROVIDER needs a publish here; new
markets on a known provider need none.

```json
{
  "1": {
    "0xdfdb56a9e2f68c74fca76c95e852d920890b36d4": {
      "kind": "smart-lp",
      "collateralToken": "0xcc28aa85f146f28fc3f47b28334be3cc3646ea16",
      "collateralSymbol": "USDT & USDe-SmartLP",
      "collateralDecimals": 18,
      "dex": "0x56a475772fc0a63752bc16ddc7e2f7a38eb97f86",
      "dexInfo": "0xd2231a59936e39d48f5c0d735bf073c7ee3de02a",
      "dexLp": "0x0d893a28e0e5cc661866eb63c3451bee590387c3",
      "coins": [
        { "address": "0x4c9edd…", "symbol": "USDe", "decimals": 18, "isNative": false },
        { "address": "0xdac17f…", "symbol": "USDT", "decimals": 6, "isNative": false }
      ]
    }
  }
}
```

**Coin order comes from the pool, never from the symbol** — the entry above is named
"USDT & USDe" but `coins` is `[USDe, USDT]`. The generator asserts
`provider.token(i) == dex.coins(i)` and `dexLP == dex.token()` on every run.

---

## Oracle classification

On top of the raw oracle files, a classification layer decodes each lender's price
oracles down to their **actual on-chain source**, classifies the provider/type, and
matches the reported pair against the **intended** asset — emitting
`data/<lender>-oracles-classified.json` per lender (Compound v3, Aave v2/v3 + v4,
Euler, Silo, Fluid) with two independent correctness signals (`correctOracle`,
`denominatorMatch`).

See **[`src/fetch/oracle-classifier/README.md`](src/fetch/oracle-classifier/README.md)**
for the architecture, schema, per-lender decoding, and `npm run update:<lender>-oracles`
commands.

## Common JSON Structure

All data files follow a consistent nesting pattern:

```
{ fork/protocol → chainId → data }
```

- All addresses are lowercased
- Chain IDs are string keys
- Fork/protocol names match the `Lender` enum values

## Config vs Data

| Directory | Purpose |
|-----------|---------|
| `config/` | Input addresses (pools, comptrollers, comets) that drive fetchers. Also updated by fetchers when new deployments are discovered. |
| `data/` | Output metadata (tokens, reserves, oracles) produced by fetchers. |

## Implementation Notes

- Fetchers use `multicallRetryUniversal()` for batched on-chain reads with retry logic
- 250–500ms sleep between chain fetches to avoid rate limiting
- `allowFailure: true` on multicalls for graceful handling of failed RPC calls
- BigInt values are serialized to strings in JSON output
- Morpho uses append-only merge logic to preserve existing market IDs
- TypeScript 6+ requires `moduleResolution: "Bundler"` (the deprecated `"Node"` option was removed); `"types": ["node"]` is set explicitly in `tsconfig.json` for Node built-in type resolution

### Liquity V2 family (`src/fetch/liquity/`)

Covers Liquity V2 and its friendly forks (USDaf, Felix, Nerite, Quill, Ēnosys
Loans, Soneta, Ebisu) — one config row per deployment, shared adapter code.

| File | Description |
|------|-------------|
| `config/liquity.json` | Hand-seeded per deployment (lender → chainId): shared addresses (CollateralRegistry, stable token, HintHelpers, MultiTroveGetter, gas-comp token), deviation params (minDebt, rate bounds, gasCompensation, debt-cap/param-getter/mutable flags), `branchAddressesRegistries` ORDERED BY collIndex (branch contracts don't expose their registry — must be seeded), per-fork `zappers` (trove-id discovery probing), `collWrappers` (wrapper-token branches), subgraph/API endpoints |
| `data/liquity-markets.json` | Generated (`npm run update:liquity`): per-branch contract sets + risk constants (CCR/MCR/SCR/BCR, liquidation penalties, debt caps) enumerated from each CollateralRegistry and read from the seeded AddressesRegistries. Re-run refreshes owner-mutable constants on proxied forks (Felix, Ēnosys, Ebisu). Also emits `priceDecimals` on NON-18-dec branches — the scale of `PriceFeed.lastGoodPrice()`, which is fork-dependent (Ebisu bakes `36 − collDecimals` into the feed; Ēnosys keeps 18 and normalizes collateral in its CR math) and is solved for against the branch's own `getCurrentICR`; left unset when the branch has no trove to sample |

Gotcha: USDaf has TWO deployments — the live V2 registry is `0x33d680…`; their
repo's broadcast manifest points at the abandoned legacy one.

### River / Satoshi Protocol (`src/fetch/river/`)

Prisma-lineage CDP behind one SatoshiXApp diamond per chain (BNB, Base, Hemi).

| File | Description |
|------|-------------|
| `config/river.json` | Hand-seeded per chain: `{ xapp, debtToken, periphery }` |
| `data/river-markets.json` | Generated (`npm run update:river`): per-chain `{ minNetDebt, markets[] }` — TroveManagers enumerated via the diamond's FactoryFacet, per-TM owner-mutable params snapshotted (MCR, interestRate, mint-fee bounds, maxSystemDebt, debtGasCompensation, pause/sunset flags) |

Facet addresses get re-cut — the updaters only ever call the diamond.

### USDD 2.0 (`src/fetch/usdd/`)

Faithful MakerDAO fork from the TRON ecosystem, deployed on Ethereum + BNB.
**The EVM CDP book is EMPTY by design** — `cdpManager.cdpi()` reads 0 on both
chains and no collateral ilk has ever been filed (every user CDP is TRON-only;
see `USDD_PLAN.md` in the lending-sdks repo). The roster stays empty until USDD
governance files an EVM ilk, and this updater doubles as the automated
re-evaluation trigger: run it quarterly (or wire it into `update:dataset`).

| File | Description |
|------|-------------|
| `config/usdd.json` | Hand-seeded per chain: core Maker surfaces (`vat`, `jug`, `spot`, `dog`, `cdpManager`, `proxyActions`, `proxyRegistry`, `usdd`, `usddJoin`), the savings pair (`pot`, `susdd`) and the 1:1 `psms[]` (swap modules, NOT markets). NB their docs list the TRON Vat address in the BNB table — the real BNB Vat (`0x41f1402a…`) was recovered via `Jug.vat()` on-chain. |
| `data/usdd-markets.json` | Generated (`npm run update:usdd`): per-chain `{ markets[], cdpi }`. Candidate ilks come from the chain-scoped API (`latest-collateral?chain=` — the chain-blind `vault/collaterals` endpoint returns the TRON book), filtered to `collateralType 1` (2 = PSM, 3 = Smart Allocator — never markets), then each is VERIFIED on-chain (Vat/Spot/Jug/Dog params, gem-join `ilk()` round-trip; on-chain values win). `cdpi` is snapshotted every run so a first EVM CDP is visible in the log even before an ilk carries debt. |

### TermMax (`src/fetch/termmax/`)

Fixed-rate, fixed-maturity AMM over zero-coupon bonds. Three layers: a MARKET
mints FT/XT/GT and holds no liquidity, per-maker ORDER contracts own the pricing
curve, and optional ERC-4626 vaults curate orders.

| File | Description |
|------|-------------|
| `config/termmax.json` | Generated (`npm run update:termmax`): per chain `{ routerV2?, routerV1?, oracleAggregatorV2, viewer, whitelistManager?, marketFactories[] }`. **Chain config only — there is no market roster file.** |

**Why no market file.** TermMax markets churn on every maturity roll (~15% of
the book turned over on a single date in Jul-2026) and matured markets *vanish
from the upstream list entirely* rather than lingering with a flag, so a
checked-in roster would be stale within weeks. `margin-fetcher` discovers
markets at runtime from the TermMax API instead.

**Everything is verified on-chain.** The chain roster and candidate addresses
come from TermMax's own API, but each address is then probed and anything that
fails is dropped — a drifted or compromised API cannot inject an address:

| Field | Probe |
|-------|-------|
| `routerV2` | `getVersion()` returns `"2.x"` |
| `viewer` | `getPositionDetails([], addr)` does not revert |
| `oracleAggregatorV2` | `getPrice(debtToken)` returns non-zero for a live market |
| `whitelistManager` | `isWhitelisted(router, MARKET)` responds |

`whitelistManager` addresses are absent from the API's `globalConfig` (docs-site
only), so they are seeded in the updater and verified like everything else.

**Gotcha — there are two routers, and they take different borrow arguments.**
Confirmed by reading each proxy's EIP-1967 implementation slot and scanning the
implementation bytecode for the selector:

| Router | Borrow entry point |
|--------|--------------------|
| **V1** (Ethereum `0xc47591f5…`) | `borrowTokenFromCollateral(recipient, market, collIn, orders[], tokenAmtsWantBuy[], maxDebt, deadline)` — takes the ORDER LIST directly (`0xfc1c1b21`) |
| **V2** (Ethereum `0xd7b162c1…`) | `borrowTokenFromCollateral(recipient, market, collIn, maxDebt, SwapPath)` — routes the FT sale through a whitelisted `TermMaxSwapAdapter` (`0x4a8f69be`) |

The V2 form needs an adapter whitelisted under `ContractModule.ADAPTER`, and
**there is none on Ethereum** — the only whitelisted adapters are Odos and
Pendle. Every market row's `routerAddr` points at V1, and TermMax's own API DTO
is the V1 `{orders[], tokenAmtsWantBuy[]}` shape. Consumers building a borrow
should target V1.

**Not every chain has a V2 router.** BNB (56) and Arbitrum (42161) expose a
router with no `getVersion`, so the updater records it as `routerV1` and leaves
`routerV2` unset rather than mislabelling it. Read the presence of `routerV2` —
do not assume it.

`getVersion()` is also how `v2` vs `v2_01` is told apart elsewhere: they are
`"2.0.0"` and `"2.0.1"`, both V2 revisions sharing one ABI. There are no live V1
*markets* — only the V1 *router* is still in use.
