import { DataManager } from "./data-manager.js";
import { LiquityOracleDataUpdater } from "./fetch/liquity-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new LiquityOracleDataUpdater());
await m.updateAll();
process.exit(0);
