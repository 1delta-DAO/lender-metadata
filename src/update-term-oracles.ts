import { DataManager } from "./data-manager.js";
import { TermOracleDataUpdater } from "./fetch/term-oracle-data.js";

const m = new DataManager();
m.registerUpdater(new TermOracleDataUpdater());
await m.updateAll();
process.exit(0);
