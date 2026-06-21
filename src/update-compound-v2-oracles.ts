import { DataManager } from "./data-manager.js";
import { CompoundV2OracleDataUpdater } from "./fetch/compound-v2-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new CompoundV2OracleDataUpdater());
await m.updateAll();
process.exit(0);
