import { DataManager } from "./data-manager.js";
import { TellerOracleDataUpdater } from "./fetch/teller-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new TellerOracleDataUpdater());
await m.updateAll();
process.exit(0);
