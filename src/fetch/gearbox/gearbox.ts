import type { Address } from "viem";
import { DataUpdater } from "../../types.js";
import { mergeData, sleep } from "../../utils.js";
import {
  GEARBOX_CONFIG,
  GEARBOX_V3,
  type GearboxChainConfig,
} from "./constants.js";
import { getBotListV310, getV310CreditManagers } from "./fetcher.js";

const resolversFile = "./config/gearbox-resolvers.json";
const labelsFile = "./data/lender-labels.json";

function labelFromName(name: string): string {
  const trimmed = name.trim();
  if (/^gearbox\b/i.test(trimmed)) return trimmed;
  return `Gearbox ${trimmed}`;
}

export class GearboxUpdater implements DataUpdater {
  name = "Gearbox";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};
    const chains: Record<string, GearboxChainConfig> = {};

    const chainEntries = Object.entries(GEARBOX_CONFIG.chains);
    for (let i = 0; i < chainEntries.length; i++) {
      const [chainId, chainCfg] = chainEntries[i];
      chains[chainId] = { ...chainCfg };
      const configurators = Object.keys(
        chainCfg.marketConfigurators
      ) as Address[];
      if (configurators.length === 0) continue;

      try {
        const botList = await getBotListV310(
          chainId,
          GEARBOX_CONFIG.addressProviderV310
        );
        chains[chainId].botList = botList.toLowerCase() as Address;
      } catch (e) {
        console.log(
          `Gearbox: failed to fetch BOT_LIST for chain ${chainId}:`,
          e
        );
      }

      try {
        const cms = await getV310CreditManagers(
          chainId,
          GEARBOX_CONFIG.marketCompressorV310,
          configurators
        );

        for (const cm of cms) {
          const key = `${GEARBOX_V3}_${cm.address.replace(/^0x/, "").toUpperCase()}`;
          const label = labelFromName(cm.name);
          names[key] = label;
          shortNames[key] = label;
        }
      } catch (e) {
        console.log(`Gearbox: failed to fetch for chain ${chainId}:`, e);
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

  mergeData(oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(oldData, data);
  }

  defaults = {};
}
