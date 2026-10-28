import { mergeData, sleep } from "../../utils.js";
import { GEARBOX_CONFIG, GEARBOX_V3, } from "./constants.js";
import { getBotListV310, getV310CreditManagers } from "./fetcher.js";
const resolversFile = "./config/gearbox-resolvers.json";
const labelsFile = "./data/lender-labels.json";
function labelFromName(name) {
    const trimmed = name.trim();
    if (/^gearbox\b/i.test(trimmed))
        return trimmed;
    return `Gearbox ${trimmed}`;
}
/**
 * Unique labels for one chain's CMs: the bare label where it is already
 * unique, otherwise the shortest suffix chain (pool → curator → address) that
 * makes it so. Exported for the test.
 */
export function disambiguateLabels(rows) {
    const tiers = [
        (r) => r.label,
        (r) => [r.label, r.pool].filter(Boolean).join(" · "),
        (r) => [r.label, r.pool, r.curator].filter(Boolean).join(" · "),
        (r) => [r.label, r.pool, r.curator, r.addr].filter(Boolean).join(" · "),
    ];
    const out = {};
    let pending = rows;
    for (let t = 0; t < tiers.length && pending.length; t++) {
        const counts = new Map();
        for (const r of pending) {
            const l = tiers[t](r);
            counts.set(l, (counts.get(l) ?? 0) + 1);
        }
        const next = [];
        for (const r of pending) {
            const l = tiers[t](r);
            if (counts.get(l) === 1 || t === tiers.length - 1)
                out[r.key] = l;
            else
                next.push(r);
        }
        pending = next;
    }
    return out;
}
export class GearboxUpdater {
    name = "Gearbox";
    async fetchData() {
        const names = {};
        const shortNames = {};
        const chains = {};
        const chainEntries = Object.entries(GEARBOX_CONFIG.chains);
        for (let i = 0; i < chainEntries.length; i++) {
            const [chainId, chainCfg] = chainEntries[i];
            chains[chainId] = { ...chainCfg };
            const configurators = Object.keys(chainCfg.marketConfigurators);
            if (configurators.length === 0)
                continue;
            try {
                const botList = await getBotListV310(chainId, GEARBOX_CONFIG.addressProviderV310);
                chains[chainId].botList = botList.toLowerCase();
            }
            catch (e) {
                console.log(`Gearbox: failed to fetch BOT_LIST for chain ${chainId}:`, e);
            }
            // One configurator at a time, so each CM knows its curator. Curators
            // routinely name CMs alike — Monad's UltraYield runs "sAUSD strategy" on
            // both its edgeUSDC and edgeAUSD pools — and two rows rendering
            // identically is the one thing a label must never do. A label that
            // collides on its chain gets the pool symbol, then the curator, then a
            // short address, until it is unique.
            const perChain = [];
            for (const configurator of configurators) {
                try {
                    const cms = await getV310CreditManagers(chainId, GEARBOX_CONFIG.marketCompressorV310, [configurator]);
                    const curator = chainCfg.marketConfigurators[configurator] ??
                        chainCfg.marketConfigurators[configurator.toLowerCase()] ??
                        "";
                    for (const cm of cms) {
                        perChain.push({
                            key: `${GEARBOX_V3}_${cm.address.replace(/^0x/, "").toUpperCase()}`,
                            label: labelFromName(cm.name),
                            pool: cm.poolSymbol,
                            curator,
                            addr: cm.address.slice(2, 8).toLowerCase(),
                        });
                    }
                }
                catch (e) {
                    console.log(`Gearbox: failed to fetch ${configurator} on chain ${chainId}:`, e);
                }
            }
            for (const [k, v] of Object.entries(disambiguateLabels(perChain))) {
                names[k] = v;
                shortNames[k] = v;
            }
            if (i < chainEntries.length - 1) {
                await sleep(500);
            }
        }
        return {
            [resolversFile]: { ...GEARBOX_CONFIG, chains },
            [labelsFile]: { names, shortNames },
        };
    }
    mergeData(oldData, data, _fileKey) {
        return mergeData(oldData, data);
    }
    defaults = {};
}
