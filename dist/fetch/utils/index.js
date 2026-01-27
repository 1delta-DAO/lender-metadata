import { getEvmClient, getEvmClientWithCustomRpcsUniversal, LIST_OVERRIDES, } from "@1delta/providers";
import * as fs from "fs";
/**
 * Reads a JSON file from a given path and parses it into a typed object.
 *
 * @param path - The file path to the JSON file
 * @returns The parsed object of type T
 */
export function readJsonFile(path) {
    try {
        const data = fs.readFileSync(path, { encoding: "utf-8" });
        return JSON.parse(data);
    }
    catch (error) {
        throw new Error(`Failed to read or parse JSON file at ${path}: ${error}`);
    }
}
export async function simulateContractRetry({ chainId, abi, address, functionName, args }, retries = 3) {
    try {
        const provider = tryGetProvider(chainId, retries - 1);
        const returnData = await provider.simulateContract({
            abi,
            functionName,
            address,
            args,
        });
        return returnData;
    }
    catch (e) {
        const newRetries = retries - 1;
        if (newRetries < 0)
            throw e;
        else
            console.log("error simulateContractRetry, retry", newRetries);
        return await simulateContractRetry({ chainId, abi, address, functionName, args }, newRetries);
    }
}
export async function multicallRetry({ chainId, contracts, allowFailure }, retries = 3, providerIndex = 0) {
    try {
        const provider = getEvmClientWithCustomRpcsUniversal({
            chain: chainId,
            rpcId: providerIndex,
            customRpcs: { ...LIST_OVERRIDES },
        });
        const returnData = await provider.multicall({
            allowFailure,
            contracts,
        });
        if (returnData.some((a) => 
        // @ts-ignore
        a?.error && JSON.stringify(a.error)?.includes("HTTP request failed"))) {
            throw new Error("", { cause: { code: "ECONNRESET" } });
        }
        return returnData;
    }
    catch (e) {
        const isHttpError = e?.cause?.code === "ECONNRESET" ||
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
        console.log(`multicall error (HTTP: ${isHttpError}), retry ${newRetries}, switching to provider ${nextProviderIndex}`, e?.message || e);
        if (newRetries < 0)
            throw e;
        return await multicallRetry({ chainId, contracts, allowFailure }, newRetries, nextProviderIndex);
    }
}
function tryGetProvider(chain, id) {
    try {
        return getEvmClient(chain, id);
    }
    catch {
        const newId = id - 1;
        if (newId < 0)
            throw Error("PROVIDER");
        else
            console.log("switch Provider");
        return tryGetProvider(chain, newId);
    }
}
