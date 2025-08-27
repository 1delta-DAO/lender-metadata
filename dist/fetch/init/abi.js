export const INIT_ABIS = [
    {
        "inputs": [],
        "name": "underlyingToken",
        "outputs": [{
                "internalType": "address",
                "name": "",
                "type": "address"
            }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "uint16",
                "name": "_mode",
                "type": "uint16"
            }
        ],
        "name": "getModeConfig",
        "outputs": [
            {
                "internalType": "address[]",
                "name": "collTokens",
                "type": "address[]"
            },
            {
                "internalType": "address[]",
                "name": "borrTokens",
                "type": "address[]"
            },
            {
                "internalType": "uint256",
                "name": "maxHealthAfterLiq_e18",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
];
export var InitFetchFunctions;
(function (InitFetchFunctions) {
    InitFetchFunctions["underlyingToken"] = "underlyingToken";
    InitFetchFunctions["getModeConfig"] = "getModeConfig";
})(InitFetchFunctions || (InitFetchFunctions = {}));
