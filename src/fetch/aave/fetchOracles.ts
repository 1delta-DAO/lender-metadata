import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { sleep } from "../../utils.js";
import { Lender } from "@1delta/lender-registry";
import { Chain } from "@1delta/chain-registry";
import { multicallRetryUniversal } from "@1delta/providers";

type OracleMap = { [chainId: string]: string };

type AaveOracleMap = { [fork: string]: OracleMap };

// aproach for aave
// get reserve list from pool
// fetch tokens per reserve from address provider
// store maps
export async function fetchAaveTypePriceOracles(
  AAVE_FORK_POOL_DATA: any
): Promise<AaveOracleMap> {
  const forks = Object.keys(AAVE_FORK_POOL_DATA);
  let forkMap: AaveOracleMap = {};
  for (const fork of forks) {
    // @ts-ignore
    const addressSet = AAVE_FORK_POOL_DATA[fork];
    const chains = Object.keys(addressSet);
    let dataMap: OracleMap = {};
    if (fork === Lender.KLAYBANK) {
      forkMap[Lender.KLAYBANK] = {
        [Chain.KAIA_MAINNET]: "0xa4BCd83C6d6C75ED9E029cde2DD24bAc2f3C5B59",
      };
      continue;
    }
    for (const chain of chains) {
      const addresses = addressSet[chain];
      console.log("fetching for", chain, fork);
      let aProvider = "0x";
      try {
        const [addressProvider] = await multicallRetryUniversal({
          chain,
          calls: [
            {
              address: addresses.protocolDataProvider,
              name: AaveFetchFunctions.ADDRESSES_PROVIDER,
              args: [],
            },
          ],
          abi: AAVE_ABIS(false),
          allowFailure: false,
        }) as any;
        aProvider = addressProvider;
        await sleep(250);
      } catch (e: any) {
        continue;
      }

      try {
        const [oracleAddress] = await multicallRetryUniversal({
          chain,
          calls: [
            {
              address: aProvider,
              name: AaveFetchFunctions.getPriceOracle,
              args: [],
            },
          ],
          abi: AAVE_ABIS(false),
          allowFailure: false,
        }) as any[];

        await sleep(250);

        dataMap[chain] = oracleAddress;
      } catch (e: any) {
        console.error(`Error fetching oracle for ${fork} on chain ${chain}, skipping:`, e instanceof Error ? e.message : e);
        continue;
      }
    }
    forkMap[fork] = dataMap;
    dataMap = {};
  }
  return forkMap;
}
