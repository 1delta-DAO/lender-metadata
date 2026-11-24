import { describe, expect, it, vi } from "vitest";

const written = new Map<string, string>();
vi.mock("./io.js", async (orig) => ({
  ...(await orig<typeof import("./io.js")>()),
  writeTextIfChanged: async (path: string, text: string) => {
    written.set(path, text);
    return "written";
  },
}));

const { DataManager } = await import("./data-manager.js");
const { mergeData: deepMergeData } = await import("./utils.js");

const LABELS = "./does-not-exist/lender-labels.json";

const labelsUpdater = (name: string, key: string) => ({
  name,
  defaults: {},
  fetchData: async () => ({ [LABELS]: { names: { [key]: name } } }),
  mergeData: (old: any, data: any) => deepMergeData(old ?? {}, data ?? {}),
});

describe("DataManager.updateAll", () => {
  it("accumulates a file shared by several updaters instead of last-writer-wins", async () => {
    const m = new DataManager();
    m.registerUpdater(labelsUpdater("Midnight", "MORPHO_MIDNIGHT_A"));
    m.registerUpdater(labelsUpdater("Term", "TERM_FINANCE_B"));
    m.registerUpdater(labelsUpdater("Resupply", "RESUPPLY_1_C"));
    await m.updateAll();

    expect(JSON.parse(written.get(LABELS)!).names).toEqual({
      MORPHO_MIDNIGHT_A: "Midnight",
      TERM_FINANCE_B: "Term",
      RESUPPLY_1_C: "Resupply",
    });
  });
});
