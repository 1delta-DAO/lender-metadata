import { zeroAddress } from "viem";
import { sleep } from "../../utils.js";
import { AAVE_ABIS, AaveFetchFunctions } from "./abi.js";
import { Lender } from "@1delta/lender-registry";
import { multicallRetry, readJsonFile } from "../utils/index.js";

interface AaveTokens {
  aToken: string;
  sToken: string;
  vToken: string;
}

type AaveMap = { [chainId: string]: { [address: string]: AaveTokens } };

type AaveForkMap = { [fork: string]: AaveMap };

type ReservesMap = { [fork: string]: { [chain: string | number]: string[] } };

const forkHasNoSToken = (ledner: String) => ledner === Lender.YLDR;

// aproach for aave
// get reserve list from pool
// fetch tokens per reserve from address provider
// store maps
export async function fetchAaveTypeTokenData(): Promise<{
  tokens: AaveForkMap;
  reserves: ReservesMap;
  AAVE_FORK_POOL_DATA: any;
}> {
  const AAVE_FORK_POOL_DATA = await readJsonFile("./config/aave-pools.json");
  const forks = Object.keys(AAVE_FORK_POOL_DATA);
  let forkMap: AaveForkMap = {};
  let reservesMap: ReservesMap = {};
  for (const fork of forks) {
    // @ts-ignore
    const addressSet = AAVE_FORK_POOL_DATA[fork];
    const chains = Object.keys(addressSet);
    let dataMap: AaveMap = {};
    reservesMap[fork] = {};
    const hasNoSToken = forkHasNoSToken(fork);
    for (const chain of chains) {
      const addresses = addressSet[chain];
      let data: any;
      console.log("fetching for", chain, fork);
      try {
        const [DataReserves] = (await multicallRetry({
          chainId: chain,
          allowFailure: false,
          contracts: [
            {
              abi: AAVE_ABIS(hasNoSToken),
              functionName: AaveFetchFunctions.getReservesList,
              address: addresses.pool,
              args: [],
            },
          ],
        })) as any;
        data = DataReserves;
        await sleep(250);
      } catch (e: any) {
        throw e;
      }
      // assign reserves
      reservesMap[fork][chain] = data.map((r: any) => r.toLowerCase());

      const AaveLenderTokens = (await multicallRetry({
        chainId: chain,
        allowFailure: false,
        contracts: data.map((addr: any) => ({
          abi: AAVE_ABIS(hasNoSToken),
          functionName: AaveFetchFunctions.getReserveTokensAddresses,
          address: addresses.protocolDataProvider,
          args: [addr],
        })),
      })) as any[];

      await sleep(250);

      const dataOnChain = hasNoSToken
        ? Object.assign(
            {},
            ...data.map((a: any, i: number) => {
              return {
                [a.toLowerCase()]: {
                  aToken: AaveLenderTokens[i][0]?.toLowerCase(),
                  vToken: AaveLenderTokens[i][1]?.toLowerCase(),
                  sToken: zeroAddress,
                },
              };
            })
          )
        : Object.assign(
            {},
            ...data.map((a: any, i: number) => {
              return {
                [a.toLowerCase()]: {
                  aToken: AaveLenderTokens[i][0]?.toLowerCase(),
                  sToken: AaveLenderTokens[i][1]?.toLowerCase(),
                  vToken: AaveLenderTokens[i][2]?.toLowerCase(),
                },
              };
            })
          );
      dataMap[chain] = dataOnChain;
    }
    forkMap[fork] = dataMap;
    dataMap = {};
  }
  return { tokens: forkMap, reserves: reservesMap, AAVE_FORK_POOL_DATA };
}
