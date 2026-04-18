import { readJsonFile } from "../utils/index.js";
export const GEARBOX_RESOLVERS = readJsonFile("./config/gearbox-resolvers.json");
export const GEARBOX_V3 = "GEARBOX_V3";
// bytes32("CONTRACTS_REGISTER") — right-padded ASCII.
export const CONTRACTS_REGISTER_KEY = "0x434f4e5452414354535f52454749535445520000000000000000000000000000";
// Gearbox registers non-versioned addresses (like ContractsRegister) under 0.
export const NO_VERSION_CONTROL = 0n;
// Gearbox v3 credit managers report version >= 300 (3_00).
export const MIN_V3_VERSION = 300n;
