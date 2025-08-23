import { AAVE_FORK_POOL_DATA } from "@1delta/asset-registry";
import { getEvmClient } from "@1delta/providers";
import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { sleep } from "../../utils.js";

type OracleMap = { [chainId: string]: string };

type AaveOracleMap = { [fork: string]: OracleMap };

// aproach for aave
// get reserve list from pool
// fetch tokens per reserve from address provider
// store maps
export async function fetchAaveTypePriceOracles(): Promise<AaveOracleMap> {
  const forks = Object.keys(AAVE_FORK_POOL_DATA);
  let forkMap: AaveOracleMap = {};
  for (const fork of forks) {
    // @ts-ignore
    const addressSet = AAVE_FORK_POOL_DATA[fork];
    const chains = Object.keys(addressSet);
    let dataMap: OracleMap = {};
    for (const chain of chains) {
      const client = getEvmClient(chain);
      const addresses = addressSet[chain];
      console.log("fetching for", chain, fork);
      let aProvider = "0x";
      try {
        const [addressProvider] = (await client.multicall({
          allowFailure: false,
          contracts: [
            {
              abi: AAVE_ABIS(false),
              functionName: AaveFetchFunctions.ADDRESSES_PROVIDER,
              address: addresses.protocolDataProvider,
              args: [],
            },
          ],
        })) as any;
        aProvider = addressProvider;
        await sleep(250);
      } catch (e: any) {
        // throw e
        continue;
      }
      // assign reserves

      const [oracleAddress] = (await client.multicall({
        allowFailure: false,
        contracts: [
          {
            abi: AAVE_ABIS(false),
            functionName: AaveFetchFunctions.getPriceOracle,
            address: aProvider as any,
            args: [],
          },
        ],
      })) as any[];

      await sleep(250);

      dataMap[chain] = oracleAddress;
    }
    forkMap[fork] = dataMap;
    dataMap = {};
  }
  return forkMap;
}
