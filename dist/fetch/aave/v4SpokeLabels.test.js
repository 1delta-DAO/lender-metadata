import { describe, expect, it } from "vitest";
import { aaveV4LenderKey, buildAaveV4Labels, discoverAaveV4SpokeNames, isPlaceholderSpokeLabel, } from "./v4SpokeLabels.js";
describe("aaveV4LenderKey", () => {
    it("matches the lender id shape (`aave-v4-<spoke>` uppercased)", () => {
        expect(aaveV4LenderKey("0x774b9655413c34809c1f1b16b654465A89EBE989")).toBe("AAVE_V4_774B9655413C34809C1F1B16B654465A89EBE989");
    });
    it("rejects anything that is not an address", () => {
        expect(() => aaveV4LenderKey("0x123")).toThrow();
    });
});
describe("isPlaceholderSpokeLabel", () => {
    it("recognises the synthetic label fetchV4Configs writes", () => {
        expect(isPlaceholderSpokeLabel("Spoke 0x774b..e989")).toBe(true);
        expect(isPlaceholderSpokeLabel(undefined)).toBe(true);
        expect(isPlaceholderSpokeLabel("  ")).toBe(true);
    });
    it("keeps real curated names", () => {
        expect(isPlaceholderSpokeLabel("Maple SyrupUSDG")).toBe(false);
        expect(isPlaceholderSpokeLabel("Main")).toBe(false);
    });
});
describe("buildAaveV4Labels", () => {
    it("prefixes the curated name and mirrors it into shortNames", () => {
        const out = buildAaveV4Labels([
            { spoke: "0x774b9655413c34809c1f1b16b654465a89ebe989", name: "Maple SyrupUSDG" },
        ]);
        const key = "AAVE_V4_774B9655413C34809C1F1B16B654465A89EBE989";
        expect(out.names[key]).toBe("Aave V4 Maple SyrupUSDG");
        expect(out.shortNames[key]).toBe("Aave V4 Maple SyrupUSDG");
    });
    it("never publishes a placeholder as a label", () => {
        const out = buildAaveV4Labels([
            { spoke: "0xb9b0b8616f6bf6841972a52058132be08d723155", name: "Spoke 0xb9b0..3155" },
            { spoke: "0x94e7a5dcbe816e498b89ab752661904e2f56c485", name: "" },
        ]);
        expect(Object.keys(out.names)).toHaveLength(0);
    });
    it("lets a later entry win, so the live API overrides the cached spokes file", () => {
        const spoke = "0x94e7a5dcbe816e498b89ab752661904e2f56c485";
        const out = buildAaveV4Labels([
            { spoke, name: "Old Name" },
            { spoke, name: "Main" },
        ]);
        expect(out.names[aaveV4LenderKey(spoke)]).toBe("Aave V4 Main");
    });
});
describe("discoverAaveV4SpokeNames", () => {
    const seed = {
        "1": [
            { hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9", attribution: "AAVE_V4_CORE" },
            { hub: "0x06002e9c4412CB7814a791eA3666D905871E536A", attribution: "AAVE_V4_PLUS" },
        ],
    };
    function gqlStub(bodies) {
        return (async (_url, init) => {
            const hub = JSON.parse(init.body).variables.hub;
            const spokes = bodies[hub];
            if (!spokes)
                throw new Error(`boom for ${hub}`);
            return { ok: true, json: async () => ({ data: { spokes } }) };
        });
    }
    it("collapses a spoke reachable through two hubs into one entry", async () => {
        const shared = {
            id: "id-shared",
            address: "0xBa1B3D55D249692b669A164024A838309B7508AF",
            name: "Ethena Ecosystem",
        };
        const out = await discoverAaveV4SpokeNames({
            hubSeed: seed,
            throttleMs: 0,
            fetchFn: gqlStub({
                "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9": [shared],
                "0x06002e9c4412CB7814a791eA3666D905871E536A": [shared],
            }),
        });
        expect(out).toHaveLength(1);
        expect(out[0].spoke).toBe("0xba1b3d55d249692b669a164024a838309b7508af");
        expect(out[0].name).toBe("Ethena Ecosystem");
    });
    it("keeps the other hubs' spokes when one hub query fails", async () => {
        const out = await discoverAaveV4SpokeNames({
            hubSeed: seed,
            throttleMs: 0,
            fetchFn: gqlStub({
                "0x06002e9c4412CB7814a791eA3666D905871E536A": [
                    { id: "id-a", address: "0x58131E79531cAb1d52301228d1f7B842f26b9649", name: "Ethena Correlated" },
                ],
            }),
        });
        expect(out.map((s) => s.name)).toEqual(["Ethena Correlated"]);
    });
});
