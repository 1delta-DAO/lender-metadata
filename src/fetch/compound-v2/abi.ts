export const COMPTROLLER_ABIS = [
  {
    inputs: [],
    name: "getAllMarkets",
    outputs: [
      { internalType: "contract VToken[]", name: "", type: "address[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "underlying",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "oracle",
    outputs: [
      { internalType: "contract PriceOracle", name: "", type: "address" },
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];

export enum CompoundV2FetchFunctions {
  getAllMarkets = "getAllMarkets",
  underlying = "underlying",
  oracle = "oracle",
}
