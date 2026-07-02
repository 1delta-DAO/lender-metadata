import { DataManager } from "./data-manager.js";
import { AaveOracleDataUpdater, AaveV4OracleDataUpdater, } from "./fetch/aave-oracle-data.js";
const m = new DataManager();
m.registerUpdater(new AaveOracleDataUpdater());
m.registerUpdater(new AaveV4OracleDataUpdater());
await m.updateAll();
process.exit(0);
