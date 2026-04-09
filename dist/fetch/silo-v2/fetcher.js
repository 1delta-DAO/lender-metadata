import { multicallRetryUniversal } from "@1delta/providers";
import { SiloConfigAbi } from "./abis.js";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
function lower(addr) {
    return addr.toLowerCase();
}
/**
 * For every API-discovered market on a given chain, multicall
 * `SiloConfig.getConfig(silo)` for both halves to fill in the static
 * metadata the API doesn't expose: share tokens, oracles, IRM, full fee
 * vector, both-side `lt`/`maxLtv`, hook receiver.
 *
 * The API has already given us each silo's underlying token address,
 * decimals and symbol — those are passed through unchanged.
 */
export async function fetchSiloV2MarketsForChain(chainId, apiMarkets) {
    if (apiMarkets.length === 0)
        return [];
    const calls = [];
    for (const m of apiMarkets) {
        calls.push({
            address: m.siloConfig,
            name: "getConfig",
            params: [m.silo0.silo],
            args: [m.silo0.silo],
        }, {
            address: m.siloConfig,
            name: "getConfig",
            params: [m.silo1.silo],
            args: [m.silo1.silo],
        });
    }
    const results = (await multicallRetryUniversal({
        chain: chainId,
        calls,
        abi: SiloConfigAbi,
        allowFailure: true,
    }));
    const out = [];
    for (let i = 0; i < apiMarkets.length; i++) {
        const market = apiMarkets[i];
        const c0 = results[i * 2];
        const c1 = results[i * 2 + 1];
        if (!c0 || c0 === "0x" || !c1 || c1 === "0x")
            continue;
        const half0 = mergeHalf(market.silo0, c0);
        const half1 = mergeHalf(market.silo1, c1);
        out.push({
            siloConfig: lower(market.siloConfig),
            name: market.name,
            silo0: half0,
            silo1: half1,
        });
    }
    return out;
}
function mergeHalf(api, cfg) {
    return {
        silo: lower(api.silo),
        token: lower(api.token || cfg.token),
        decimals: api.decimals,
        symbol: api.symbol,
        protectedShareToken: lower(cfg.protectedShareToken),
        collateralShareToken: lower(cfg.collateralShareToken),
        debtShareToken: lower(cfg.debtShareToken),
        solvencyOracle: lower(cfg.solvencyOracle),
        maxLtvOracle: lower(cfg.maxLtvOracle),
        interestRateModel: lower(cfg.interestRateModel),
        maxLtv: cfg.maxLtv.toString(),
        lt: cfg.lt.toString(),
        liquidationTargetLtv: cfg.liquidationTargetLtv.toString(),
        liquidationFee: cfg.liquidationFee.toString(),
        flashloanFee: cfg.flashloanFee.toString(),
        daoFee: cfg.daoFee.toString(),
        deployerFee: cfg.deployerFee.toString(),
        hookReceiver: cfg.hookReceiver && lower(cfg.hookReceiver) !== ZERO_ADDR
            ? lower(cfg.hookReceiver)
            : undefined,
        callBeforeQuote: !!cfg.callBeforeQuote,
    };
}
