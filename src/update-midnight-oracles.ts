import { DataManager } from "./data-manager.js";
import { MidnightOracleDataUpdater } from "./fetch/midnight-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new MidnightOracleDataUpdater());
await m.updateAll();
process.exit(0);
