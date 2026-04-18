import { mergeData, sleep } from "../../utils.js";
import { GEARBOX_RESOLVERS, GEARBOX_V3 } from "./constants.js";
import { getAllCreditManagers, getContractsRegister, getV3CreditManagers, } from "./fetcher.js";
const resolversFile = "./config/gearbox-resolvers.json";
const labelsFile = "./data/lender-labels.json";
function labelFromName(name) {
    const trimmed = name.trim();
    if (/^gearbox\b/i.test(trimmed))
        return trimmed;
    return `Gearbox ${trimmed}`;
}
export class GearboxUpdater {
    name = "Gearbox";
    async fetchData() {
        const names = {};
        const shortNames = {};
        const chainEntries = Object.entries(GEARBOX_RESOLVERS);
        for (let i = 0; i < chainEntries.length; i++) {
            const [chainId, resolvers] = chainEntries[i];
            try {
                const contractsRegister = await getContractsRegister(chainId, resolvers);
                const cmAddresses = await getAllCreditManagers(chainId, contractsRegister);
                const cms = await getV3CreditManagers(chainId, cmAddresses);
                for (const cm of cms) {
                    const key = `${GEARBOX_V3}_${cm.address.replace(/^0x/, "").toUpperCase()}`;
                    const label = labelFromName(cm.name);
                    names[key] = label;
                    shortNames[key] = label;
                }
            }
            catch (e) {
                console.log(`Gearbox: failed to fetch for chain ${chainId}:`, e);
            }
            if (i < chainEntries.length - 1) {
                await sleep(500);
            }
        }
        return {
            [resolversFile]: GEARBOX_RESOLVERS,
            [labelsFile]: { names, shortNames },
        };
    }
    mergeData(oldData, data, _fileKey) {
        return mergeData(oldData, data);
    }
    defaults = {};
}
