import { mergeData } from "../utils.js";
import { classifyTermOracles } from "./term/classifyOracles.js";
const oraclesClassifiedFile = "./data/term-finance-oracles-classified.json";
export class TermOracleDataUpdater {
    name = "Term Finance Oracle Classification";
    async fetchData() {
        const data = await classifyTermOracles();
        return { [oraclesClassifiedFile]: data };
    }
    /** Replace wholesale — keeping stale chain/token keys would be misleading. */
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
