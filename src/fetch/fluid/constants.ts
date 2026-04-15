import type { Address } from "viem";
import { readJsonFile } from "../utils/index.js";

export type FluidResolvers = {
  lendingResolver: Address;
  vaultResolver: Address;
  liquidityResolver: Address;
};

export const FLUID_RESOLVERS: Record<string, FluidResolvers> = readJsonFile(
  "./config/fluid-resolvers.json"
);

export const FLUID_LENDING = "FLUID_LENDING";
export const FLUID_VAULT = "FLUID_VAULT";
