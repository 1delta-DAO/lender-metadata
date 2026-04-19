import type { Address } from "viem";
import { readJsonFile } from "../utils/index.js";

export type GearboxChainConfig = {
  marketConfigurators: Record<string, string>;
};

export type GearboxV310Config = {
  addressProviderV310: Address;
  marketCompressorV310: Address;
  chains: Record<string, GearboxChainConfig>;
};

export const GEARBOX_CONFIG: GearboxV310Config = readJsonFile(
  "./config/gearbox-resolvers.json"
);

export const GEARBOX_V3 = "GEARBOX_V3";
