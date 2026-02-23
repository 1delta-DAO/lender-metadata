export const genericFactoryAbi = [
    {
        type: "function",
        name: "getProxyListLength",
        inputs: [],
        outputs: [{ type: "uint256", name: "" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getProxyListSlice",
        inputs: [
            { type: "uint256", name: "start" },
            { type: "uint256", name: "end" },
        ],
        outputs: [{ type: "address[]", name: "list" }],
        stateMutability: "view",
    },
];
export const eVaultAbi = [
    {
        type: "function",
        name: "asset",
        inputs: [],
        outputs: [{ type: "address", name: "" }],
        stateMutability: "view",
    },
];
