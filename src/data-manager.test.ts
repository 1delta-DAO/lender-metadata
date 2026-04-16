import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataManager } from "./data-manager.js";
import { mergeData } from "./utils.js";
import type { DataUpdater } from "./types.js";

const sharedFile = "./data/shared.json";

describe("DataManager", () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "lender-metadata-test-"));
    await mkdir(join(tempDir, "data"), { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps updates from earlier updaters writing same file", async () => {
    await writeFile(
      sharedFile,
      JSON.stringify({ a: "old-a", b: "old-b" }, null, 2) + "\n",
      "utf8"
    );

    const updaterA: DataUpdater = {
      name: "Updater A",
      defaults: {},
      async fetchData() {
        return { [sharedFile]: { a: "new-a" } };
      },
      mergeData(oldData: any, data: any) {
        return mergeData(oldData, data);
      },
    };

    const updaterB: DataUpdater = {
      name: "Updater B",
      defaults: {},
      async fetchData() {
        return { [sharedFile]: { b: "new-b" } };
      },
      mergeData(oldData: any, data: any) {
        return mergeData(oldData, data);
      },
    };

    const manager = new DataManager();
    manager.registerUpdater(updaterA);
    manager.registerUpdater(updaterB);

    await manager.updateAll();

    const updated = JSON.parse(await readFile(sharedFile, "utf8"));
    expect(updated).toEqual({ a: "new-a", b: "new-b" });
  });
});
