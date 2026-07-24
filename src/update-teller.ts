import { DataManager } from "./data-manager.js";
import { TellerPoolsUpdater } from "./fetch/teller-pools-data.js";

const m = new DataManager();
m.registerUpdater(new TellerPoolsUpdater());
await m.updateAll();
process.exit(0);
