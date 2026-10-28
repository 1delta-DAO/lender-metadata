import { stringToHex, zeroAddress } from "viem";
import { getEvmClientUniversal, multicallRetryUniversal } from "@1delta/providers";
import { addressProviderV310Abi, marketCompressorAbi } from "./abi.js";
const BOT_LIST_KEY = stringToHex("BOT_LIST", { size: 32 });
// AddressProviderV310 is itself a v3.10-specific provider and stores all of its
// entries with `_version = 0` (the version arg distinguishes legacy entries on
// older AddressProviders). Calling with 310 reverts AddressNotFoundException.
const ADDRESS_PROVIDER_VERSION = 0n;
/**
 * Query MarketCompressor for every market under the given configurators and
 * return one entry per credit suite (i.e. per credit manager). Markets span
 * pools and CMs, so the same CM never appears twice across the returned data.
 */
export async function getV310CreditManagers(chainId, marketCompressor, configurators) {
    if (configurators.length === 0)
        return [];
    const filter = { configurators, pools: [], underlying: zeroAddress };
    let markets;
    try {
        const [viaMulticall] = (await multicallRetryUniversal({
            chain: chainId,
            calls: [{ address: marketCompressor, name: "getMarkets", args: [filter] }],
            abi: marketCompressorAbi,
            allowFailure: false,
        }));
        if (Array.isArray(viaMulticall) && viaMulticall.length)
            markets = viaMulticall;
    }
    catch {
        // fall through to the direct call
    }
    // `getMarkets` walks every market of the configurators. On Monad the inner
    // call runs out of gas inside Multicall3's `aggregate3` and comes back as an
    // empty result rather than an error — a SILENT "no credit managers", which
    // left all 21 Monad CMs without a label (the Curvance ProtocolReader trap).
    // A direct `eth_call` has the full gas budget; rotate RPCs on failure.
    let lastErr;
    for (let rpcId = 0; !markets && rpcId < 4; rpcId++) {
        try {
            markets = (await getEvmClientUniversal({
                chain: chainId,
                rpcId,
                timeoutMs: 30_000,
            }).readContract({
                address: marketCompressor,
                abi: marketCompressorAbi,
                functionName: "getMarkets",
                args: [filter],
            }));
        }
        catch (e) {
            lastErr = e;
        }
    }
    if (!markets)
        throw lastErr ?? new Error(`getMarkets returned nothing on ${chainId}`);
    const out = [];
    for (const market of markets ?? []) {
        for (const suite of market.creditManagers ?? []) {
            const cm = suite.creditManager;
            const facade = suite.creditFacade;
            const addr = cm?.baseParams?.addr;
            const name = cm?.name;
            if (!addr || typeof name !== "string" || name.length === 0)
                continue;
            out.push({
                address: addr,
                name,
                expirationDate: BigInt(facade?.expirationDate ?? 0),
                isPaused: Boolean(facade?.isPaused),
                poolSymbol: typeof market?.pool?.symbol === "string" && market.pool.symbol
                    ? market.pool.symbol
                    : undefined,
            });
        }
    }
    return out;
}
export async function getBotListV310(chainId, addressProvider) {
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
    }));
    return botList;
}
