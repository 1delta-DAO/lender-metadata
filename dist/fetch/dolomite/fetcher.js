import { createPublicClient, http } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { dolomiteMarginReadAbi, DOLOMITE_FALLBACK_RPCS, } from "./constants.js";
/**
 * Reads `getNumMarkets` then `getMarketTokenAddress(0..n-1)` for a chain and
 * returns the marketId → token (lowercased) map. Tries the shared
 * `@1delta/providers` multicall first; falls back to a direct viem client for
 * chains not in the provider's chain registry (e.g. Polygon zkEVM, Superseed).
 */
export async function fetchDolomiteMarkets(chainId, dolomiteMargin) {
    try {
        return await fetchViaMulticall(chainId, dolomiteMargin);
    }
    catch (e) {
        const rpc = DOLOMITE_FALLBACK_RPCS[chainId];
        if (!rpc)
            throw e;
        return await fetchViaDirectRpc(rpc, dolomiteMargin);
    }
}
async function fetchViaMulticall(chainId, dolomiteMargin) {
    const [numRaw] = (await multicallRetryUniversal({
        chain: chainId,
        calls: [{ address: dolomiteMargin, name: "getNumMarkets", args: [] }],
        abi: dolomiteMarginReadAbi,
        allowFailure: false,
    }));
    const n = Number(numRaw);
    if (!n)
        return {};
    const calls = Array.from({ length: n }, (_, i) => ({
        address: dolomiteMargin,
        name: "getMarketTokenAddress",
        args: [BigInt(i)],
    }));
    const tokens = (await multicallRetryUniversal({
        chain: chainId,
        calls,
        abi: dolomiteMarginReadAbi,
        allowFailure: true,
    }));
    return toMarketsMap(tokens);
}
async function fetchViaDirectRpc(rpc, dolomiteMargin) {
    const client = createPublicClient({ transport: http(rpc) });
    const n = Number(await client.readContract({
        address: dolomiteMargin,
        abi: dolomiteMarginReadAbi,
        functionName: "getNumMarkets",
    }));
    if (!n)
        return {};
    const tokens = await Promise.all(Array.from({ length: n }, (_, i) => client
        .readContract({
        address: dolomiteMargin,
        abi: dolomiteMarginReadAbi,
        functionName: "getMarketTokenAddress",
        args: [BigInt(i)],
    })
        .catch(() => null)));
    return toMarketsMap(tokens);
}
function toMarketsMap(tokens) {
    const markets = {};
    tokens.forEach((t, i) => {
        if (t && typeof t === "string" && t !== "0x") {
            markets[String(i)] = t.toLowerCase();
        }
    });
    return markets;
}
