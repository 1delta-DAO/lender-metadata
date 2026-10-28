import { describe, expect, it } from "vitest";
import { disambiguateLabels } from "./gearbox.js";
const row = (key, label, pool, curator = "UltraYield", addr = key.slice(-6)) => ({
    key,
    label,
    pool,
    curator,
    addr,
});
describe("disambiguateLabels", () => {
    it("keeps a unique label bare", () => {
        expect(disambiguateLabels([row("A", "Gearbox WETH strategy", "edgeUSDC")])).toEqual({ A: "Gearbox WETH strategy" });
    });
    it("separates two CMs one curator named alike by their pool (Monad edgeUSDC / edgeAUSD)", () => {
        const out = disambiguateLabels([
            row("A", "Gearbox sAUSD strategy", "edgeUSDC"),
            row("B", "Gearbox sAUSD strategy", "edgeAUSD"),
            row("C", "Gearbox mEDGE strategy", "edgeUSDC"),
        ]);
        expect(out).toEqual({
            A: "Gearbox sAUSD strategy · edgeUSDC",
            B: "Gearbox sAUSD strategy · edgeAUSD",
            C: "Gearbox mEDGE strategy",
        });
    });
    it("falls back to the curator, then the address, until every label is unique", () => {
        const out = disambiguateLabels([
            row("A", "Gearbox Tier 1", "dWETH", "kpk", "aaaaaa"),
            row("B", "Gearbox Tier 1", "dWETH", "Re7", "bbbbbb"),
            row("C", "Gearbox Tier 1", "dWETH", "Re7", "cccccc"),
        ]);
        expect(out.A).toBe("Gearbox Tier 1 · dWETH · kpk");
        expect(out.B).toBe("Gearbox Tier 1 · dWETH · Re7 · bbbbbb");
        expect(out.C).toBe("Gearbox Tier 1 · dWETH · Re7 · cccccc");
        expect(new Set(Object.values(out)).size).toBe(3);
    });
});
