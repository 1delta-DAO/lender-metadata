import { DataManager } from "./data-manager.js";
import { CompoundV3OracleDataUpdater } from "./fetch/compound-v3-oracle-data.js";
const m = new DataManager();
m.registerUpdater(new CompoundV3OracleDataUpdater());
await m.updateAll();
process.exit(0);
