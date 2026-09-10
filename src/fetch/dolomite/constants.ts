// DolomiteMargin + Expiry + calldata proxies per chain (from
// dolomite-margin/migrations/deployed.json), non-testnet only. The proxies feed
// the calldata-sdk `DolomiteLending` / `DolomiteTrader` encoders.
export interface DolomiteDeployment {
  dolomiteMargin: string;
  expiry: string;
  depositWithdrawalProxy: string;
  borrowPositionProxy: string; // BorrowPositionProxyV1 (ungated, same-owner)
  genericTraderProxy: string; // GenericTraderProxyV2 (swaps / loops) — see below
  /**
   * 1delta's own `OdosExecutor`
   * (`contracts-delegation`, `contracts/1delta/composer/generic/OdosExecutor.sol`).
   *
   * It carries the Odos executor selector and forwards to ANY aggregator's
   * router, which turns Dolomite's `odos` `IExchangeWrapper` into a generic one:
   * `OdosAggregatorTrader` forwards `executor` + `pathDefinition` verbatim and
   * `OdosRouterV2` validates neither. That matters because a Dolomite swap must
   * route through a Dolomite-DEPLOYED wrapper and we cannot add one — so without
   * this, a chain is limited to whichever aggregators Dolomite happened to
   * deploy for, and Base/Mantle have only `odos`, whose API has been down since
   * 2026-08.
   *
   * Present ONLY where both the contract is deployed AND the chain has an `odos`
   * wrapper for it to ride. Absent means the consumer must not offer the route
   * (`getDolomiteAdmittedAggregators` fails closed on it).
   */
  odosExecutor?: string;
}

/**
 * `GenericTraderProxyV2` — ONE CREATE2 address on every Dolomite chain, and the
 * only trader proxy `DolomiteMargin.getIsGlobalOperator` returns true for.
 *
 * The per-chain V1 addresses this replaced are all DEAUTHORIZED: verified false
 * on 10 of 11 chains on 2026-09-10 (Botanix's RPC was unreachable), against V2
 * true on those same 10. A call through a deauthorized proxy reverts with EMPTY
 * revert data before it reaches an aggregator, which is why the breakage was
 * invisible — it looks like an encoder bug, not a config one. V2 accepts the
 * V1-shaped calldata unchanged (fork-proven on Ethereum: a leveraged open
 * executed with the encoders untouched, only this address changed).
 */
const GENERIC_TRADER_PROXY_V2 = "0xD6C1b15716742689c5b33C19c78D9d2a1494bF33";

/**
 * `OdosExecutor`, deployed by 1delta via CREATE2 at one address on every chain
 * that has an `odos` wrapper. Bytecode verified byte-identical to the pinned
 * hardhat build (0.8.34 / 1e6 runs / paris) on all four, 2026-09-10.
 */
const ODOS_EXECUTOR = "0x72aDF1a2e9b404386f846079E88c0E281BF2Fe23";

// Most chains share the CREATE2 deployment; Arbitrum, Mantle, Polygon zkEVM and
// X Layer have distinct core addresses. `genericTraderProxy` is the exception:
// V2 is one address everywhere, so it is set from the shared constant on every
// chain rather than overridden per chain.
const SHARED = {
  dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
  expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  depositWithdrawalProxy: "0xd6a31B6AeA4d26A19bF479b5032D9DDc481187e6",
  borrowPositionProxy: "0x67567Fce98A44745820069C37C395426F1C30ba6",
  genericTraderProxy: GENERIC_TRADER_PROXY_V2,
};

export const DOLOMITE_DEPLOYMENTS: Record<string, DolomiteDeployment> = {
  "1": { ...SHARED, odosExecutor: ODOS_EXECUTOR },
  "56": { ...SHARED },
  "196": {
    dolomiteMargin: "0x836b557Cf9eF29fcF49C776841191782df34e4e5",
    expiry: "0x8B808a1fEEf1d9cdd00Fb46A19e4814e5646197C",
    depositWithdrawalProxy: "0xDC94f0C55c9A21b02f2743cf4B77Fa02329355Fd",
    borrowPositionProxy: "0xB4F0eB9c8fb5FBabEF339f8738173dB645c4147d",
    genericTraderProxy: GENERIC_TRADER_PROXY_V2,
  },
  "1101": {
    dolomiteMargin: "0x836b557Cf9eF29fcF49C776841191782df34e4e5",
    expiry: "0xb3F81b0F53CDEe755c70665923e08a8f0e81d0c3",
    depositWithdrawalProxy: "0xDfB6BAA334712cBBeb26B7537f62B81C2a87B1E8",
    borrowPositionProxy: "0xc28A4EC9f09E4071E3707eAACa5c3754fA4f5Faa",
    genericTraderProxy: GENERIC_TRADER_PROXY_V2,
  },
  "3637": { ...SHARED },
  "5000": {
    dolomiteMargin: "0xE6Ef4f0B2455bAB92ce7cC78E35324ab58917De8",
    expiry: "0x6df6DBF5053c3771217376fb3ef7F1f5d4889a25",
    depositWithdrawalProxy: "0x1A3752Eb5Db6B2Ac0207Ce3847f18743D3fAccA5",
    borrowPositionProxy: "0x97a08604a56f16947a4a956eFEc2Ef223364b733",
    genericTraderProxy: GENERIC_TRADER_PROXY_V2,
    odosExecutor: ODOS_EXECUTOR,
  },
  "5330": { ...SHARED },
  "8453": { ...SHARED, odosExecutor: ODOS_EXECUTOR },
  "42161": {
    dolomiteMargin: "0x6Bd780E7fDf01D77e4d475c821f1e7AE05409072",
    expiry: "0xDEc1ae3b570ac3c57871BBD7bFeacC807f973Bea",
    depositWithdrawalProxy: "0xAdB9D68c613df4AA363B42161E1282117C7B9594",
    borrowPositionProxy: "0xe43638797513ef7A6d326a95E8647d86d2f5a099",
    genericTraderProxy: GENERIC_TRADER_PROXY_V2,
    odosExecutor: ODOS_EXECUTOR,
  },
  "57073": { ...SHARED },
  "80094": { ...SHARED },
};

// Direct-RPC fallback for chains not covered by @1delta/providers' viem registry
// (verified: Polygon zkEVM and Superseed). Used only when multicall throws.
export const DOLOMITE_FALLBACK_RPCS: Record<string, string> = {
  "1101": "https://zkevm-rpc.com",
  "5330": "https://mainnet.superseed.xyz",
};

// Dolomite subgraph endpoints (public gateway, key-in-URL — no API key). Used to
// discover the per-chain risk-override setter (`defaultAccountRiskOverrideSetter`),
// which is null on chains without e-mode (e.g. legacy Arbitrum).
const DOLO_SUBGRAPH = (slug: string) =>
  `https://subgraph.api.dolomite.io/api/public/1301d2d1-7a9d-4be4-9e9a-061cb8611549/subgraphs/dolomite-${slug}/latest/gn`;

export const DOLOMITE_SUBGRAPH_URLS: Record<string, string> = {
  "1": DOLO_SUBGRAPH("ethereum"),
  "56": DOLO_SUBGRAPH("bsc"),
  "196": DOLO_SUBGRAPH("x-layer"),
  "1101": DOLO_SUBGRAPH("polygon-zkevm"),
  "3637": DOLO_SUBGRAPH("botanix"),
  "5000": DOLO_SUBGRAPH("mantle"),
  "8453": DOLO_SUBGRAPH("base"),
  "42161": DOLO_SUBGRAPH("arbitrum"),
  "80094": DOLO_SUBGRAPH("berachain-mainnet"),
};

// E-mode category + risk-feature enums (DolomiteAccountRiskOverrideSetter).
export const DOLOMITE_CATEGORIES = ["NONE", "BERA", "BTC", "ETH", "STABLE"] as const;
export const DOLOMITE_RISK_FEATURES = [
  "NONE",
  "BORROW_ONLY",
  "SINGLE_COLLATERAL_WITH_STRICT_DEBT",
] as const;

// Read ABI for the DolomiteAccountRiskOverrideSetter (a.k.a. e-mode setter).
const decimalTuple = {
  components: [{ name: "value", type: "uint256" }],
  type: "tuple",
} as const;
export const dolomiteRiskOverrideSetterAbi = [
  {
    inputs: [{ name: "marketId", type: "uint256" }],
    name: "getCategoryByMarketId",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "category", type: "uint8" }],
    name: "getCategoryParamByCategory",
    outputs: [
      {
        components: [
          { name: "category", type: "uint8" },
          { ...decimalTuple, name: "marginRatioOverride" },
          { ...decimalTuple, name: "liquidationRewardOverride" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "marketId", type: "uint256" }],
    name: "getRiskFeatureByMarketId",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "marketId", type: "uint256" }],
    name: "getRiskFeatureForSingleCollateralByMarketId",
    outputs: [
      {
        components: [
          { name: "debtMarketIds", type: "uint256[]" },
          { ...decimalTuple, name: "marginRatioOverride" },
          { ...decimalTuple, name: "liquidationRewardOverride" },
        ],
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Minimal DolomiteMargin read ABI — only the two functions the markets map needs.
// (The deployed contracts predate `getMarketWithInfo`; these granular getters are
// stable across versions.)
export const dolomiteMarginReadAbi = [
  {
    inputs: [],
    name: "getNumMarkets",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "marketId", type: "uint256" }],
    name: "getMarketTokenAddress",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
