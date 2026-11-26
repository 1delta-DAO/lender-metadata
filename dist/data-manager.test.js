import { describe, expect, it, vi } from "vitest";
const written = new Map();
vi.mock("./io.js", async (orig) => ({
    ...(await orig()),
    writeTextIfChanged: async (path, text) => {
        written.set(path, text);
        return "written";
    },
}));
const { DataManager } = await import("./data-manager.js");
const { mergeData: deepMergeData } = await import("./utils.js");
const LABELS = "./does-not-exist/lender-labels.json";
const labelsUpdater = (name, key) => ({
    name,
    defaults: {},
    fetchData: async () => ({ [LABELS]: { names: { [key]: name } } }),
    mergeData: (old, data) => deepMergeData(old ?? {}, data ?? {}),
});
describe("DataManager.updateAll", () => {
    it("accumulates a file shared by several updaters instead of last-writer-wins", async () => {
        const m = new DataManager();
        m.registerUpdater(labelsUpdater("Midnight", "MORPHO_MIDNIGHT_A"));
        m.registerUpdater(labelsUpdater("Term", "TERM_FINANCE_B"));
        m.registerUpdater(labelsUpdater("Resupply", "RESUPPLY_1_C"));
        await m.updateAll();
        expect(JSON.parse(written.get(LABELS)).names).toEqual({
            MORPHO_MIDNIGHT_A: "Midnight",
            TERM_FINANCE_B: "Term",
            RESUPPLY_1_C: "Resupply",
        });
    });
});
