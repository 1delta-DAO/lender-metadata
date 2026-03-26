import { DataManager } from "./data-manager.js";
import { MorphoOracleDataUpdater } from "./fetch/morpho-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new MorphoOracleDataUpdater());
await m.updateAll();
process.exit(0);
