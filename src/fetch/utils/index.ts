import { getEvmClient } from "@1delta/providers";
import * as fs from "fs";

/**
 * Reads a JSON file from a given path and parses it into a typed object.
 *
 * @param path - The file path to the JSON file
 * @returns The parsed object of type T
 */
export function readJsonFile(path: string) {
  try {
    const data = fs.readFileSync(path, { encoding: "utf-8" });
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`Failed to read or parse JSON file at ${path}: ${error}`);
  }
}

export async function simulateContractRetry(
  { chainId, abi, address, functionName, args }: any,
  retries = 3
) {
  try {
    const provider = tryGetProvider(chainId, retries - 1);

    const returnData = await provider.simulateContract({
      abi,
      functionName,
      address,
      args,
    });
    return returnData;
  } catch (e) {
    console.log("retry");
    const newRetries = retries - 1;
    if (newRetries < 0) throw e;
    else console.log("error simulateContractRetry, retry", newRetries);
    return await simulateContractRetry(
      { chainId, abi, address, functionName, args },
      newRetries
    );
  }
}

export async function multicallRetry(
  { chainId, contracts, allowFailure }: any,
  retries = 3
) {
  try {
    const provider = tryGetProvider(chainId, retries - 1);
    const returnData = await provider.multicall({
      allowFailure,
      contracts,
    });
    return returnData;
  } catch (e) {
    const newRetries = retries - 1;
    console.log("retry");
    if (newRetries < 0) throw e;
    else console.log("error multicall, retry", newRetries);
    return await multicallRetry(
      { chainId, contracts, allowFailure },
      newRetries
    );
  }
}

function tryGetProvider(chain: any, id: number) {
  try {
    return getEvmClient(chain, id);
  } catch {
    const newId = id - 1;
    if (newId < 0) throw Error("PROVIDER");
    else console.log("switch Provider");

    return tryGetProvider(chain, newId);
  }
}
