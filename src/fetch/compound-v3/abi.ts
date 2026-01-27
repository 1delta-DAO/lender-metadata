export const COMET_ABIS = [
  {
    inputs: [],
    name: "baseToken",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "numAssets",
    outputs: [
      {
        internalType: "uint8",
        name: "",
        type: "uint8",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "baseBorrowMin",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint8",
        name: "i",
        type: "uint8",
      },
    ],
    name: "getAssetInfo",
    outputs: [
      {
        components: [
          {
            internalType: "uint8",
            name: "offset",
            type: "uint8",
          },
          {
            internalType: "address",
            name: "asset",
            type: "address",
          },
          {
            internalType: "address",
            name: "priceFeed",
            type: "address",
          },
          {
            internalType: "uint64",
            name: "scale",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "borrowCollateralFactor",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "liquidateCollateralFactor",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "liquidationFactor",
            type: "uint64",
          },
          {
            internalType: "uint128",
            name: "supplyCap",
            type: "uint128",
          },
        ],
        internalType: "struct CometCore.AssetInfo",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  { internalType: "address", name: "baseToken", type: "address" },
  { internalType: "address", name: "baseTokenPriceFeed", type: "address" },
];

export enum CompoundV3FetchFunctions {
  baseToken = "baseToken",
  getAssetInfo = "getAssetInfo",
  numAssets = "numAssets",
  baseBorrowMin = "baseBorrowMin",
  baseTokenPriceFeed = "baseTokenPriceFeed",
}
