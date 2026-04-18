import type { Address } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import {
  addressProviderAbi,
  contractsRegisterAbi,
  creditManagerAbi,
} from "./abi.js";
import {
  CONTRACTS_REGISTER_KEY,
  GearboxResolvers,
  MIN_V3_VERSION,
  NO_VERSION_CONTROL,
} from "./constants.js";

export interface GearboxCreditManager {
  address: Address;
  name: string;
}

export async function getContractsRegister(
  chainId: string,
  resolvers: GearboxResolvers
): Promise<Address> {
  const [addr] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      {
        address: resolvers.addressProvider,
        name: "getAddressOrRevert",
        args: [CONTRACTS_REGISTER_KEY, NO_VERSION_CONTROL],
      },
    ],
    abi: addressProviderAbi,
    allowFailure: false,
  })) as [Address];
  return addr;
}

export async function getAllCreditManagers(
  chainId: string,
  contractsRegister: Address
): Promise<Address[]> {
  const [list] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      {
        address: contractsRegister,
        name: "getCreditManagers",
        args: [],
      },
    ],
    abi: contractsRegisterAbi,
    allowFailure: false,
  })) as [Address[]];
  return list ?? [];
}

/**
 * Fetch (name, version) for every CM and filter to v3 (version >= 300) with a
 * non-empty name. v2 CMs don't expose `name()`, so they drop out naturally via
 * allowFailure.
 */
export async function getV3CreditManagers(
  chainId: string,
  cms: Address[]
): Promise<GearboxCreditManager[]> {
  if (cms.length === 0) return [];

  const calls = cms.flatMap((cm) => [
    { address: cm, name: "name" as const, args: [] },
    { address: cm, name: "version" as const, args: [] },
  ]);

  const results = (await multicallRetryUniversal({
    chain: chainId,
    calls,
    abi: creditManagerAbi,
    allowFailure: true,
  })) as any[];

  const out: GearboxCreditManager[] = [];
  for (let i = 0; i < cms.length; i++) {
    const name = results[i * 2];
    const version = results[i * 2 + 1];
    if (typeof name !== "string" || name.length === 0) continue;
    if (version === undefined || version === null) continue;
    if (BigInt(version) < MIN_V3_VERSION) continue;
    out.push({ address: cms[i], name });
  }
  return out;
}
