/**
 * Selectors probed when classifying an on-chain price feed / oracle.
 *
 * The classifier walks an oracle's source graph by calling a battery of
 * "pointer" selectors (each returns the address of an underlying feed/aggregator)
 * plus a set of "info" selectors (description / decimals / data feed id) that
 * describe a single node. All selectors are no-arg view functions, so they can be
 * batched into a single multicall with `allowFailure: true` — a feed simply does
 * not implement most of them.
 */

const addrOut = [{ internalType: "address", name: "", type: "address" }];

/** Selectors that return the address of an underlying feed/aggregator. */
export const POINTER_SELECTORS = [
  // Chainlink EACAggregatorProxy -> underlying aggregator
  "aggregator",
  // Compound scaling / wrapper feeds
  "underlyingPriceFeed",
  "priceFeed",
  // Compound multiplicative / reverse feeds combine two sources
  "priceFeedA",
  "priceFeedB",
  // generic wrapper indirection (also used by Morpho wrapper oracles)
  "currentOracle",
  // Morpho ChainlinkOracleV2 composite signals
  "BASE_FEED_1",
  "BASE_FEED_2",
  "QUOTE_FEED_1",
  "QUOTE_FEED_2",
  "BASE_VAULT",
  "QUOTE_VAULT",
] as const;

export type PointerSelector = (typeof POINTER_SELECTORS)[number];

export const POINTER_ABI = POINTER_SELECTORS.map((name) => ({
  inputs: [],
  name,
  outputs: addrOut,
  stateMutability: "view",
  type: "function",
}));

/** Selectors that describe a single node. */
export const INFO_ABI = [
  {
    inputs: [],
    name: "description",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  // RedStone price feeds expose the symbol as a bytes32 data feed id
  {
    inputs: [],
    name: "getDataFeedId",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
];

/** ERC20 symbol(), used to resolve the symbols of the assets an oracle prices. */
export const SYMBOL_ABI = [
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

export const PROBE_ABI = [...POINTER_ABI, ...INFO_ABI];
