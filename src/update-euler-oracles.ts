import { DataManager } from "./data-manager.js";
import { EulerOracleDataUpdater } from "./fetch/euler-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new EulerOracleDataUpdater());
await m.updateAll();
process.exit(0);
