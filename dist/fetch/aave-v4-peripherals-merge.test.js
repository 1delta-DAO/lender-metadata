import { describe, expect, it } from "vitest";
import { mergeAaveV4PeripheralsData, mergePositionManagerLists, } from "./aave/fetchV4Peripherals.js";
describe("mergePositionManagerLists", () => {
    it("merges by address and prefers incoming fields", () => {
        const prev = [
            { name: "Old", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", active: true },
        ];
        const next = [
            { name: "New", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", active: false },
        ];
        const out = mergePositionManagerLists(prev, next);
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe("New");
        expect(out[0].active).toBe(false);
        expect(out[0].address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });
    it("sorts by address", () => {
        const out = mergePositionManagerLists([{ name: "b", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", active: true }], [{ name: "a", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", active: true }]);
        expect(out[0].address.startsWith("0xaa")).toBe(true);
        expect(out[1].address.startsWith("0xbb")).toBe(true);
    });
});
describe("mergeAaveV4PeripheralsData", () => {
    it("keeps prior gateways when incoming are empty", () => {
        const oldData = {
            "1": {
                nativeGateway: "0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be",
                signatureGateway: "0xfbc184337dc6595d8bf62968bda46e7de7af9c3d",
                forks: {},
            },
        };
        const newData = {
            "1": {
                nativeGateway: "",
                signatureGateway: "",
                forks: {
                    AAVE_V4_CORE: {
                        hub: "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9",
                        spokes: {},
                    },
                },
            },
        };
        const out = mergeAaveV4PeripheralsData(oldData, newData);
        expect(out["1"].nativeGateway).toBe("0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be");
        expect(out["1"].signatureGateway).toBe("0xfbc184337dc6595d8bf62968bda46e7de7af9c3d");
        expect(out["1"].forks.AAVE_V4_CORE?.hub).toBe("0xcca852bc40e560adc3b1cc58ca5b55638ce826c9");
    });
    it("merges position managers per spoke without dropping prior addresses", () => {
        const addr = "0x973a023a77420ba610f06b3858ad991df6d85a08";
        const oldData = {
            "1": {
                nativeGateway: "0x1111111111111111111111111111111111111111",
                signatureGateway: "0x2222222222222222222222222222222222222222",
                forks: {
                    AAVE_V4_CORE: {
                        hub: "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9",
                        spokes: {
                            [addr]: {
                                spokeName: "Bluechip",
                                spokeId: "id-old",
                                positionManagers: [
                                    {
                                        name: "PM",
                                        address: "0x3333333333333333333333333333333333333333",
                                        active: true,
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        };
        const newData = {
            "1": {
                nativeGateway: "0xe68ab4f90fe026b9873f5f276ed2d7efbbbbe42be",
                signatureGateway: "0xfbc184337dc6595d8bf62968bda46e7de7af9c3d",
                forks: {
                    AAVE_V4_CORE: {
                        hub: "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9",
                        spokes: {
                            [addr]: {
                                spokeName: "Bluechip",
                                spokeId: "id-new",
                                positionManagers: [
                                    {
                                        name: "Other",
                                        address: "0x4444444444444444444444444444444444444444",
                                        active: true,
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        };
        const out = mergeAaveV4PeripheralsData(oldData, newData);
        const pms = out["1"].forks.AAVE_V4_CORE?.spokes[addr]?.positionManagers ?? [];
        expect(pms.some((p) => p.address === "0x3333333333333333333333333333333333333333")).toBe(true);
        expect(pms.some((p) => p.address === "0x4444444444444444444444444444444444444444")).toBe(true);
    });
});
