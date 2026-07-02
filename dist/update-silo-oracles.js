import { DataManager } from "./data-manager.js";
import { SiloOracleDataUpdater } from "./fetch/silo-oracle-data.js";
const m = new DataManager();
m.registerUpdater(new SiloOracleDataUpdater());
await m.updateAll();
process.exit(0);
