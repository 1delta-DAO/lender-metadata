import type { Address } from "viem";
import { stringToHex, zeroAddress } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { addressProviderV310Abi, marketCompressorAbi } from "./abi.js";

const BOT_LIST_KEY = stringToHex("BOT_LIST", { size: 32 });
// AddressProviderV310 is itself a v3.10-specific provider and stores all of its
// entries with `_version = 0` (the version arg distinguishes legacy entries on
// older AddressProviders). Calling with 310 reverts AddressNotFoundException.
const ADDRESS_PROVIDER_VERSION = 0n;

export interface GearboxCreditManager {
  address: Address;
  name: string;
  expirationDate: bigint;
  isPaused: boolean;
}

/**
 * Query MarketCompressor for every market under the given configurators and
 * return one entry per credit suite (i.e. per credit manager). Markets span
 * pools and CMs, so the same CM never appears twice across the returned data.
 */
export async function getV310CreditManagers(
  chainId: string,
  marketCompressor: Address,
  configurators: Address[]
): Promise<GearboxCreditManager[]> {
  if (configurators.length === 0) return [];

  const [markets] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      {
        address: marketCompressor,
        name: "getMarkets",
        args: [
          {
            configurators,
            pools: [],
            underlying: zeroAddress,
          },
        ],
      },
    ],
    abi: marketCompressorAbi,
    allowFailure: false,
  })) as [readonly any[]];

  const out: GearboxCreditManager[] = [];
  for (const market of markets ?? []) {
    for (const suite of market.creditManagers ?? []) {
      const cm = suite.creditManager;
      const facade = suite.creditFacade;
      const addr = cm?.baseParams?.addr as Address | undefined;
      const name = cm?.name as string | undefined;
      if (!addr || typeof name !== "string" || name.length === 0) continue;
      out.push({
        address: addr,
        name,
        expirationDate: BigInt(facade?.expirationDate ?? 0),
        isPaused: Boolean(facade?.isPaused),
      });
    }
  }
  return out;
}

export async function getBotListV310(
  chainId: string,
  addressProvider: Address
): Promise<Address> {
  const [botList] = (await multicallRetryUniversal({
    chain: chainId,
    calls: [
      {
        address: addressProvider,
        name: "getAddressOrRevert",
        args: [BOT_LIST_KEY, ADDRESS_PROVIDER_VERSION],
      },
    ],
    abi: addressProviderV310Abi,
    allowFailure: false,
  })) as [Address];
  return botList;
}
