export const addressProviderAbi = [
  {
    type: "function",
    name: "getAddressOrRevert",
    inputs: [
      { type: "bytes32", name: "key" },
      { type: "uint256", name: "_version" },
    ],
    outputs: [{ type: "address", name: "result" }],
    stateMutability: "view",
  },
] as const;

export const contractsRegisterAbi = [
  {
    type: "function",
    name: "getCreditManagers",
    inputs: [],
    outputs: [{ type: "address[]", name: "" }],
    stateMutability: "view",
  },
] as const;

export const creditManagerAbi = [
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ type: "string", name: "" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "version",
    inputs: [],
    outputs: [{ type: "uint256", name: "" }],
    stateMutability: "view",
  },
] as const;
