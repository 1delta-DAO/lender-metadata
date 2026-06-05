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
