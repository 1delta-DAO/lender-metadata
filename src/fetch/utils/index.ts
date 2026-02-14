import {
  getEvmClient,
  getEvmClientUniversal,
  getEvmClientWithCustomRpcsUniversal,
  LIST_OVERRIDES,
} from "@1delta/providers";
import * as fs from "fs";
import { sleep } from "../../utils";

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
  retries = 3,
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
    const newRetries = retries - 1;
    if (newRetries < 0) throw e;
    else console.log("error simulateContractRetry, retry", newRetries);
    return await simulateContractRetry(
      { chainId, abi, address, functionName, args },
      newRetries,
    );
  }
}

const MAX_PROVIDER_INDEX = 5;

export async function multicallRetry(
  { chainId, contracts, allowFailure }: any,
  retries = 3,
  providerIndex = 0,
  attempt = 0,
) {
  try {
    const provider = getEvmClientWithCustomRpcsUniversal({
      chain: chainId,
      rpcId: providerIndex % (MAX_PROVIDER_INDEX + 1),
      customRpcs: { ...LIST_OVERRIDES },
    });

    const returnData = await provider.multicall({
      allowFailure,
      contracts,
      batchSize: chainId === "1" ? 200 : undefined,
    });

    if (
      returnData.some(
        (a) =>
          // @ts-ignore
          a?.error && JSON.stringify(a.error)?.includes("HTTP request failed"),
      )
    ) {
      throw new Error("", { cause: { code: "ECONNRESET" } });
    }

    return returnData;
  } catch (e: any) {
    const isHttpError =
      e?.cause?.code === "ECONNRESET" ||
      e?.cause?.code === "ETIMEDOUT" ||
      e?.cause?.code === "ENOTFOUND" ||
      e?.code === "ECONNRESET" ||
      e?.code === "ETIMEDOUT" ||
      e?.code === "ENOTFOUND" ||
      e?.message?.includes("HTTP") ||
      e?.message?.includes("fetch") ||
      e?.message?.includes("429") ||
      e?.message?.includes("403") ||
      e?.message?.includes("502") ||
      e?.message?.includes("503") ||
      e?.message?.includes("504") ||
      e?.status === 429 ||
      e?.status >= 500;

    const newRetries = retries - 1;
    const nextProviderIndex = isHttpError ? providerIndex + 1 : providerIndex;

    console.log(
      `multicall error (HTTP: ${isHttpError}), retry ${newRetries}, provider ${nextProviderIndex % (MAX_PROVIDER_INDEX + 1)}`,
      e?.message || e,
    );

    if (newRetries < 0) throw e;
    const backoff = Math.min(250 * Math.pow(2, attempt), 5000);
    await sleep(backoff);
    return await multicallRetry(
      { chainId, contracts, allowFailure },
      newRetries,
      nextProviderIndex,
      attempt + 1,
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
