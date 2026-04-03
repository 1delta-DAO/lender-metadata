import { loadExisting } from "../utils.js";
import { fetchAaveV4Peripherals, mergeAaveV4PeripheralsData, } from "./aave/fetchV4Peripherals.js";
const hubsFile = "./config/aave-v4-hubs.json";
const outFile = "./config/aave-v4-peripherals.json";
export class AaveV4PeripheralsUpdater {
    name = "Aave V4 Peripherals";
    async fetchData() {
        const hubSeed = await loadExisting(hubsFile);
        const data = await fetchAaveV4Peripherals(hubSeed);
        return { [outFile]: data };
    }
    mergeData(oldData, data, fileKey) {
        if (fileKey === outFile) {
            return mergeAaveV4PeripheralsData(oldData ?? {}, data ?? {});
        }
        return data;
    }
    defaults = {};
}
