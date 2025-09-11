export const AAVE_ABIS = (noSToken) => [
    {
        inputs: [],
        name: "getPriceOracle",
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
        name: "getAddressesProvider",
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
        name: "getPoolDataProvider",
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
        name: "POOL",
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
        name: "ADDRESSES_PROVIDER",
        outputs: [
            {
                internalType: "contract IPoolAddressesProvider",
                name: "",
                type: "address",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "getReservesList",
        outputs: [
            {
                internalType: "address[]",
                name: "",
                type: "address[]",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            {
                internalType: "address",
                name: "asset",
                type: "address",
            },
        ],
        name: "getReserveTokensAddresses",
        outputs: noSToken
            ? [
                {
                    internalType: "address",
                    name: "aTokenAddress",
                    type: "address",
                },
                {
                    internalType: "address",
                    name: "variableDebtTokenAddress",
                    type: "address",
                },
            ]
            : [
                {
                    internalType: "address",
                    name: "aTokenAddress",
                    type: "address",
                },
                {
                    internalType: "address",
                    name: "stableDebtTokenAddress",
                    type: "address",
                },
                {
                    internalType: "address",
                    name: "variableDebtTokenAddress",
                    type: "address",
                },
            ],
        stateMutability: "view",
        type: "function",
    },
];
export var AaveFetchFunctions;
(function (AaveFetchFunctions) {
    AaveFetchFunctions["getReservesList"] = "getReservesList";
    AaveFetchFunctions["ADDRESSES_PROVIDER"] = "ADDRESSES_PROVIDER";
    AaveFetchFunctions["getPriceOracle"] = "getPriceOracle";
    AaveFetchFunctions["getReserveTokensAddresses"] = "getReserveTokensAddresses";
})(AaveFetchFunctions || (AaveFetchFunctions = {}));
