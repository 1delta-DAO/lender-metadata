export const MORPHO_CHAINLINK_ORACLE_V2_ABI = [
  // Reachability sentinel. Every Morpho oracle implements `IOracle.price()`,
  // including the non-V2 ones that revert on all six selectors below — so a
  // failed `price()` means the ORACLE WAS NOT REACHED, while a successful one
  // alongside six failures means the oracle genuinely has no feeds. Without it
  // a transport failure is indistinguishable from "this oracle has nothing",
  // and gets written as fact. See fetchOracleConfigs.
  {
    inputs: [],
    name: "price",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "BASE_FEED_1",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "BASE_FEED_2",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "QUOTE_FEED_1",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "QUOTE_FEED_2",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "BASE_VAULT",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "QUOTE_VAULT",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

export const VAULT_SYMBOL_ABI = [
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

export const VAULT_ASSET_ABI = [
  {
    inputs: [],
    name: "asset",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

export const CURRENT_ORACLE_ABI = [
  {
    inputs: [],
    name: "currentOracle",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

export const FEED_DESCRIPTION_ABI = [
  {
    inputs: [],
    name: "description",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

export const VAULT_ACCOUNTING_ASSET_ABI = [
  {
    inputs: [],
    name: "accountingAsset",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

export const REDSTONE_DATA_FEED_ID_ABI = [
  {
    inputs: [],
    name: "getDataFeedId",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
];
