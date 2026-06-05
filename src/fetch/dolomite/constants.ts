// DolomiteMargin + Expiry per chain (from dolomite-margin/migrations/deployed.json),
// non-testnet only. `expiry` is informational for the data-sdk config.
export interface DolomiteDeployment {
  dolomiteMargin: string;
  expiry: string;
}

export const DOLOMITE_DEPLOYMENTS: Record<string, DolomiteDeployment> = {
  "1": {
    dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  },
  "56": {
    dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  },
  "196": {
    dolomiteMargin: "0x836b557Cf9eF29fcF49C776841191782df34e4e5",
    expiry: "0x8B808a1fEEf1d9cdd00Fb46A19e4814e5646197C",
  },
  "1101": {
    dolomiteMargin: "0x836b557Cf9eF29fcF49C776841191782df34e4e5",
    expiry: "0xb3F81b0F53CDEe755c70665923e08a8f0e81d0c3",
  },
  "3637": {
    dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  },
  "5000": {
    dolomiteMargin: "0xE6Ef4f0B2455bAB92ce7cC78E35324ab58917De8",
    expiry: "0x6df6DBF5053c3771217376fb3ef7F1f5d4889a25",
  },
  "5330": {
    dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  },
  "8453": {
    dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  },
  "42161": {
    dolomiteMargin: "0x6Bd780E7fDf01D77e4d475c821f1e7AE05409072",
    expiry: "0xDEc1ae3b570ac3c57871BBD7bFeacC807f973Bea",
  },
  "57073": {
    dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  },
  "80094": {
    dolomiteMargin: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
    expiry: "0x2Ae007882b91206942c70ADc833A61Ee531D8D5D",
  },
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
