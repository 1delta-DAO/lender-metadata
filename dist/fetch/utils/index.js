import { getEvmClient, getEvmClientWithCustomRpcsUniversal, LIST_OVERRIDES, } from "@1delta/providers";
import * as fs from "fs";
import { sleep } from "../../utils";
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
const MAX_PROVIDER_INDEX = 5;
export async function multicallRetry({ chainId, contracts, allowFailure }, retries = MAX_PROVIDER_INDEX + 1, providerIndex = 0, attempt = 0) {
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
        const isRpcResultError = (a) => {
            // @ts-ignore
            if (!a?.error)
                return false;
            // @ts-ignore
            const errStr = JSON.stringify(a.error);
            return (errStr?.includes("HTTP request failed") ||
                errStr?.includes("not whitelisted") ||
                errStr?.includes("-32601") ||
                errStr?.includes("401"));
        };
        const rpcErrorCount = returnData.filter(isRpcResultError).length;
        // Only retry if ALL results failed (full RPC outage) or if allowFailure is false and any failed
        if (rpcErrorCount > 0 &&
            (rpcErrorCount === returnData.length || !allowFailure)) {
            throw new Error("RPC provider error in multicall results", {
                cause: { code: "ECONNRESET" },
            });
        }
        return returnData;
    }
    catch (e) {
        // Non-retryable: chain not supported by the provider library at all
        if (typeof e?.message === "string" && e.message.startsWith("Not in VIEM:"))
            throw e;
        const errorString = e?.message || "";
        const detailsString = typeof e?.details === "string" ? e.details : JSON.stringify(e?.details ?? "");
        const combinedError = `${errorString} ${detailsString}`;
        const isHttpError = e?.cause?.code === "ECONNRESET" ||
            e?.cause?.code === "ETIMEDOUT" ||
            e?.cause?.code === "ENOTFOUND" ||
            e?.code === "ECONNRESET" ||
            e?.code === "ETIMEDOUT" ||
            e?.code === "ENOTFOUND" ||
            combinedError.includes("HTTP") ||
            combinedError.includes("fetch") ||
            combinedError.includes("timed out") ||
            combinedError.includes("took too long") ||
            combinedError.includes("RPC Request failed") ||
            combinedError.includes("429") ||
            combinedError.includes("401") ||
            combinedError.includes("403") ||
            combinedError.includes("502") ||
            combinedError.includes("503") ||
            combinedError.includes("504") ||
            combinedError.includes("not whitelisted") ||
            combinedError.includes("-32601") ||
            combinedError.includes("took too long") ||
            combinedError.includes("timed out") ||
            combinedError.includes("timeout") ||
            e?.status === 401 ||
            e?.status === 429 ||
            e?.status >= 500;
        const newRetries = retries - 1;
        const nextProviderIndex = isHttpError ? providerIndex + 1 : providerIndex;
        console.log(`multicall error (HTTP: ${isHttpError}), retry ${newRetries}, ` +
            `provider ${providerIndex % (MAX_PROVIDER_INDEX + 1)} → ${nextProviderIndex % (MAX_PROVIDER_INDEX + 1)}`, e?.message || e);
        if (newRetries < 0)
            throw e;
        const backoff = Math.min(250 * Math.pow(2, attempt), 15000);
        await sleep(backoff);
        return await multicallRetry({ chainId, contracts, allowFailure }, newRetries, nextProviderIndex, attempt + 1);
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
