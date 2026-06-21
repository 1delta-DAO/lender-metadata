import { DataManager } from "./data-manager.js";
import { DolomiteOracleDataUpdater } from "./fetch/dolomite-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new DolomiteOracleDataUpdater());
await m.updateAll();
process.exit(0);
