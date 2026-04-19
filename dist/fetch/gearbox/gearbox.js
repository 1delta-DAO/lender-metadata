import { mergeData, sleep } from "../../utils.js";
import { GEARBOX_CONFIG, GEARBOX_V3 } from "./constants.js";
import { getV310CreditManagers } from "./fetcher.js";
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
        const chainEntries = Object.entries(GEARBOX_CONFIG.chains);
        for (let i = 0; i < chainEntries.length; i++) {
            const [chainId, chainCfg] = chainEntries[i];
            const configurators = Object.keys(chainCfg.marketConfigurators);
            if (configurators.length === 0)
                continue;
            try {
                const cms = await getV310CreditManagers(chainId, GEARBOX_CONFIG.marketCompressorV310, configurators);
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
            [resolversFile]: GEARBOX_CONFIG,
            [labelsFile]: { names, shortNames },
        };
    }
    mergeData(oldData, data, _fileKey) {
        return mergeData(oldData, data);
    }
    defaults = {};
}
