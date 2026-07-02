import { mergeData } from "../utils.js";
import { classifyFluidOracles } from "./fluid/classifyOracles.js";
const fluidClassifiedFile = "./data/fluid-oracles-classified.json";
export class FluidOracleDataUpdater {
    name = "Fluid Oracle Classification";
    async fetchData() {
        const data = await classifyFluidOracles();
        return { [fluidClassifiedFile]: data };
    }
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
