import { describe, expect, it } from "vitest";
import { backfillReserveDetailsFromOracles, backfillReserveDetailsHubFromConfig, mergeArrayData, mergeOracleSourcesArrayData, mergeReserveDetailsData, normalizeReserveDetailsPersisted, } from "./aave-v4.js";
describe("mergeArrayData (Aave V4 oracles)", () => {
    it("dedupes rows that differ only by underlying (historical merge key bug)", () => {
        const oldData = {
            FORK: {
                "1": [
                    {
                        underlying: "",
                        spoke: "0xAbC",
                        reserveId: 0,
                        oracle: "0x1111111111111111111111111111111111111111",
                    },
                    {
                        underlying: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                        spoke: "0xabc",
                        reserveId: 0,
                        oracle: "0x1111111111111111111111111111111111111111",
                    },
                ],
            },
        };
        const out = mergeArrayData(oldData, {});
        expect(out.FORK["1"]).toHaveLength(1);
        expect(out.FORK["1"][0].underlying).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
        expect(out.FORK["1"][0].spoke).toBe("0xabc");
    });
    it("incoming with valid oracle merges fields without wiping known underlying", () => {
        const oldData = {
            FORK: {
                "1": [
                    {
                        underlying: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        spoke: "0xspoke",
                        reserveId: 1,
                        oracle: "0x2222222222222222222222222222222222222222",
                    },
                ],
            },
        };
        const newData = {
            FORK: {
                "1": [
                    {
                        underlying: "",
                        spoke: "0xspoke",
                        reserveId: 1,
                        oracle: "0x2222222222222222222222222222222222222222",
                    },
                ],
            },
        };
        const out = mergeArrayData(oldData, newData);
        expect(out.FORK["1"]).toHaveLength(1);
        expect(out.FORK["1"][0].underlying).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });
    it("incoming with invalid oracle does not replace existing oracle", () => {
        const oldData = {
            FORK: {
                "1": [
                    {
                        underlying: "0xu",
                        spoke: "0xs",
                        reserveId: 2,
                        oracle: "0x3333333333333333333333333333333333333333",
                    },
                ],
            },
        };
        const newData = {
            FORK: {
                "1": [
                    {
                        underlying: "",
                        spoke: "0xs",
                        reserveId: 2,
                        oracle: "0x0000000000000000000000000000000000000000",
                    },
                ],
            },
        };
        const out = mergeArrayData(oldData, newData);
        expect(out.FORK["1"][0].oracle).toBe("0x3333333333333333333333333333333333333333");
    });
});
describe("mergeOracleSourcesArrayData", () => {
    it("keeps prior non-empty source when incoming fetch has empty source (same valid oracle)", () => {
        const oldData = {
            FORK: {
                "1": [
                    {
                        underlying: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        spoke: "0xspoke",
                        reserveId: 1,
                        oracle: "0x2222222222222222222222222222222222222222",
                        decimals: 8,
                        source: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    },
                ],
            },
        };
        const newData = {
            FORK: {
                "1": [
                    {
                        underlying: "",
                        spoke: "0xspoke",
                        reserveId: 1,
                        oracle: "0x2222222222222222222222222222222222222222",
                        decimals: 8,
                        source: "",
                    },
                ],
            },
        };
        const out = mergeOracleSourcesArrayData(oldData, newData);
        expect(out.FORK["1"]).toHaveLength(1);
        expect(out.FORK["1"][0].source).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        expect(out.FORK["1"][0].underlying).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });
});
describe("mergeReserveDetailsData", () => {
    it("merges by reserveId and keeps non-empty underlying when incoming is empty", () => {
        const spoke = "0xspoke0000000000000000000000000000000000000";
        const oldData = {
            F: {
                "1": {
                    [spoke]: [
                        {
                            reserveId: 0,
                            underlying: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            hub: "0xhubhubhubhubhubhubhubhubhubhubhubhubhubhub",
                            assetId: 1,
                            decimals: 18,
                            collateralRisk: 0,
                            dynamicConfigKeyMax: 0,
                            borrowable: true,
                            paused: false,
                            frozen: false,
                            latestDynamicConfig: {
                                collateralFactor: 1,
                                maxLiquidationBonus: 2,
                                liquidationFee: 3,
                            },
                        },
                    ],
                },
            },
        };
        const newData = {
            F: {
                "1": {
                    [spoke]: [
                        {
                            reserveId: 0,
                            underlying: "",
                            hub: "",
                            assetId: 0,
                            decimals: 18,
                            collateralRisk: 0,
                            dynamicConfigKeyMax: 0,
                            borrowable: false,
                            paused: false,
                            frozen: false,
                            latestDynamicConfig: null,
                        },
                    ],
                },
            },
        };
        const out = mergeReserveDetailsData(oldData, newData);
        const row = out.F["1"][spoke][0];
        expect(row.underlying).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        expect(row.hub).toBe("0xhubhubhubhubhubhubhubhubhubhubhubhubhubhub");
    });
    it("backfills underlying from oracles when detail row is empty", () => {
        const spoke = "0x65407b940966954b23dfa3caa5c0702bb42984dc";
        const details = {
            X: {
                "1": {
                    [spoke]: [{ reserveId: 0, underlying: "" }],
                },
            },
        };
        const oracles = {
            X: {
                "1": [
                    {
                        underlying: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                        spoke,
                        reserveId: 0,
                        oracle: "0x37c316996c714bf906743071e04e62220b3271ac",
                    },
                ],
            },
        };
        const out = backfillReserveDetailsFromOracles(details, oracles);
        expect(out.X["1"][spoke][0].underlying).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    });
    it("backfills hub from hub seed when empty", () => {
        const spoke = "0xspoke";
        const details = {
            CORE: {
                "1": {
                    [spoke]: [{ reserveId: 0, underlying: "0xu", hub: "" }],
                },
            },
        };
        const hubSeed = {
            CORE: { "1": { hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9" } },
        };
        const out = backfillReserveDetailsHubFromConfig(details, hubSeed);
        expect(out.CORE["1"][spoke][0].hub).toBe("0xcca852bc40e560adc3b1cc58ca5b55638ce826c9");
    });
    it("does not overwrite non-empty hub", () => {
        const spoke = "0xspoke";
        const existingHub = "0x1111111111111111111111111111111111111111";
        const details = {
            CORE: {
                "1": {
                    [spoke]: [{ reserveId: 0, underlying: "0xu", hub: existingHub }],
                },
            },
        };
        const hubSeed = {
            CORE: { "1": { hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9" } },
        };
        const out = backfillReserveDetailsHubFromConfig(details, hubSeed);
        expect(out.CORE["1"][spoke][0].hub).toBe(existingHub);
    });
    it("normalizeReserveDetailsPersisted runs merge, oracle, then hub backfill", () => {
        const spoke = "0xs";
        const details = {
            F: {
                "1": {
                    [spoke]: [
                        { reserveId: 0, underlying: "", hub: "" },
                    ],
                },
            },
        };
        const oracles = {
            F: {
                "1": [
                    {
                        underlying: "0xabc0000000000000000000000000000000000001",
                        spoke,
                        reserveId: 0,
                        oracle: "0xo",
                    },
                ],
            },
        };
        const hubSeed = {
            F: {
                "1": { hub: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
            },
        };
        const out = normalizeReserveDetailsPersisted(details, { oracles, hubSeed });
        expect(out.F["1"][spoke][0].underlying).toBe("0xabc0000000000000000000000000000000000001");
        expect(out.F["1"][spoke][0].hub).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    });
});
