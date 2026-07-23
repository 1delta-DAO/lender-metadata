import { DataManager } from "./data-manager.js";
import { ExactlyOracleDataUpdater } from "./fetch/exactly-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new ExactlyOracleDataUpdater());
await m.updateAll();
process.exit(0);
