import { zeroAddress } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { marketCompressorAbi } from "./abi.js";
/**
 * Query MarketCompressor for every market under the given configurators and
 * return one entry per credit suite (i.e. per credit manager). Markets span
 * pools and CMs, so the same CM never appears twice across the returned data.
 */
export async function getV310CreditManagers(chainId, marketCompressor, configurators) {
    if (configurators.length === 0)
        return [];
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
    }));
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
            });
        }
    }
    return out;
}
