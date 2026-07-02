import { DataManager } from "./data-manager.js";
import { FluidOracleDataUpdater } from "./fetch/fluid-oracle-data.js";
const m = new DataManager();
m.registerUpdater(new FluidOracleDataUpdater());
await m.updateAll();
process.exit(0);
