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

**`aave-v4-spokes.json`** — discovered spokes:
```json
{
  "AAVE_V4_CORE": {
    "1": [
      { "spoke": "0x...", "oracle": "0x...", "label": "Spoke 0" }
    ]
  }
}
```

**`aave-v4-oracles.json`** — array per chain, keyed by underlying + spoke + reserveId:
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
