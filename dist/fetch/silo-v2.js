import { loadExisting, mergeData } from "../utils.js";
import { DEFAULTS, DEFAULTS_SHORT } from "./defaults.js";
import { fetchAllSilos, } from "./silo-shared/graphql.js";
import { buildAllSiloLabels } from "./silo-labels.js";
const peripheralsFile = "./config/silo-v2-peripherals.json";
const marketsFile = "./data/silo-v2-markets.json";
const labelsFile = "./data/lender-labels.json";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
/**
 * Silo v2 lender metadata.
 *
 * Both discovery and all static config fields come from the Silo v3
 * GraphQL indexer (`https://api-v3.silo.finance`). That indexer serves
 * whitelisted v2 markets alongside v3 — we filter by
 * `protocol.protocolVersion === "v2"` and map into the existing v2
 * on-disk shape so downstream `data-sdk` consumers keep working without
 * changes.
 *
 * Notes:
 * - No on-chain `SiloConfig.getConfig` pass. The indexer exposes every
 *   field the old multicall produced except `callBeforeQuote`, which we
 *   default to `false` (every live v2 market currently has this flag
 *   unset, so it's a no-op migration).
 * - Coverage is larger than the old REST endpoint: the public v2 borrow
 *   API only returned markets with active liquidity, the indexer returns
 *   every whitelisted market.
 */
export class SiloV2Updater {
    name = "Silo V2";
    async fetchData() {
        const peripherals = await loadExisting(peripheralsFile);
        const raw = await fetchAllSilos();
        const markets = {};
        for (const s of raw) {
            if (s.protocol?.protocolVersion !== "v2")
                continue;
            const entry = toV2Entry(s);
            if (!entry)
                continue;
            (markets[String(s.chainId)] ??= []).push(entry);
        }
        for (const chain of Object.keys(markets)) {
            markets[chain].sort((a, b) => a.siloConfig.localeCompare(b.siloConfig));
        }
        const chainCounts = Object.entries(markets).map(([c, l]) => `${c}:${l.length}`);
        console.log(`Silo V2: fetched ${chainCounts.length} chains from API (${chainCounts.join(", ")})`);
        // Emit the *complete* v2+v3 label set so the second updater writing
        // to lender-labels.json doesn't clobber the first. See the comment in
        // `silo-labels.ts` for the rationale.
        const labels = buildAllSiloLabels(raw);
        return {
            [peripheralsFile]: peripherals,
            [marketsFile]: markets,
            [labelsFile]: labels,
        };
    }
    mergeData(oldData, data, fileKey) {
        if (fileKey === marketsFile) {
            const merged = { ...(oldData ?? {}) };
            for (const chain of Object.keys(data ?? {})) {
                merged[chain] = data[chain];
            }
            return merged;
        }
        if (fileKey === labelsFile) {
            return mergeData(oldData, data, this.defaults[labelsFile]);
        }
        return mergeData(oldData, data);
    }
    defaults = {
        [labelsFile]: { names: DEFAULTS, shortNames: DEFAULTS_SHORT },
    };
}
function lower(s) {
    return (s ?? "").toLowerCase();
}
function toV2Half(m, hookReceiver) {
    return {
        silo: lower(m.id),
        token: lower(m.inputToken?.id),
        decimals: m.inputToken?.decimals ?? 0,
        symbol: m.inputToken?.symbol,
        protectedShareToken: lower(m.spTokenId),
        collateralShareToken: lower(m.sTokenId),
        debtShareToken: lower(m.dTokenId),
        solvencyOracle: lower(m.solvencyOracleAddress),
        maxLtvOracle: lower(m.maxLtvOracleAddress),
        interestRateModel: lower(m.interestRateModelId),
        maxLtv: m.maxLtv,
        lt: m.lt,
        liquidationTargetLtv: m.liquidationTargetLtv,
        liquidationFee: m.liquidationFee,
        flashloanFee: m.flashLoanFee,
        daoFee: m.daoFee,
        deployerFee: m.deployerFee,
        hookReceiver,
        // The GraphQL indexer doesn't expose `callBeforeQuote`. Every live v2
        // market currently has it `false`, so defaulting here is lossless.
        callBeforeQuote: false,
    };
}
function toV2Entry(s) {
    if (!s.market1 || !s.market2)
        return null;
    const hr = s.gaugeHookReceiver && lower(s.gaugeHookReceiver) !== ZERO_ADDR
        ? lower(s.gaugeHookReceiver)
        : undefined;
    const byIndex = {};
    byIndex[s.market1.index] = toV2Half(s.market1, hr);
    byIndex[s.market2.index] = toV2Half(s.market2, hr);
    const silo0 = byIndex[0];
    const silo1 = byIndex[1];
    if (!silo0 || !silo1)
        return null;
    // Preserve the existing on-disk name format: `<sym0>/<sym1>` (slash).
    return {
        siloConfig: lower(s.configAddress),
        name: `${silo0.symbol ?? "?"}/${silo1.symbol ?? "?"}`,
        silo0,
        silo1,
    };
}
