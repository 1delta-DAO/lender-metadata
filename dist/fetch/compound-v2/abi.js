export const COMPTROLLER_ABIS = [
    { "inputs": [], "name": "getAllMarkets", "outputs": [{ "internalType": "contract VToken[]", "name": "", "type": "address[]" }], "stateMutability": "view", "type": "function" },
    { "inputs": [], "name": "underlying", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];
export var CompoundV2FetchFunctions;
(function (CompoundV2FetchFunctions) {
    CompoundV2FetchFunctions["getAllMarkets"] = "getAllMarkets";
    CompoundV2FetchFunctions["underlying"] = "underlying";
})(CompoundV2FetchFunctions || (CompoundV2FetchFunctions = {}));
