import { DataUpdater } from "../../types.js";
import { mergeData, sleep } from "../../utils.js";
import { FLUID_RESOLVERS, FLUID_LENDING, FLUID_VAULT } from "./constants.js";
import {
  getAllVaultAddresses,
  getAllFTokenAddresses,
  getFTokenMetas,
  getVaultMetas,
  buildFTokensByUnderlying,
  FluidVaultMeta,
  FluidVaultSide,
} from "./fetcher.js";

const resolversFile = "./config/fluid-resolvers.json";
const vaultsFile = "./data/fluid-vaults.json";
const labelsFile = "./data/lender-labels.json";

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

type TokenList = Record<string, { symbol: string; decimals: number }>;

const getListUrl = (chainId: string) =>
  `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;

async function getTokenList(chainId: string): Promise<TokenList> {
  try {
    const r = await fetch(getListUrl(chainId));
    if (!r.ok) return {};
    const json = (await r.json()) as any;
    return (json.list as TokenList) ?? {};
  } catch {
    return {};
  }
}

function symbolFor(underlying: string, tokens: TokenList): string {
  if (underlying === NATIVE_SENTINEL) return "ETH";
  const meta = tokens[underlying];
  if (meta?.symbol) return meta.symbol;
  return underlying.slice(0, 6);
}

function sideLabel(side: FluidVaultSide, tokens: TokenList): string {
  return side.assets.map((a) => symbolFor(a.underlying, tokens)).join("+");
}

export class FluidUpdater implements DataUpdater {
  name = "Fluid";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const vaults: Record<string, Record<string, FluidVaultMeta>> = {};

    const names: Record<string, string> = {};
    const shortNames: Record<string, string> = {};
    names[FLUID_LENDING] = "Fluid Lending";
    shortNames[FLUID_LENDING] = "Fluid";

    const chainEntries = Object.entries(FLUID_RESOLVERS);
    for (let i = 0; i < chainEntries.length; i++) {
      const [chainId, resolvers] = chainEntries[i];
      try {
        const [vaultAddrs, fTokenAddrs, tokens] = await Promise.all([
          getAllVaultAddresses(chainId, resolvers),
          getAllFTokenAddresses(chainId, resolvers),
          getTokenList(chainId),
        ]);

        const fTokenMetas = await getFTokenMetas(chainId, fTokenAddrs);
        const fTokensByUnderlying = buildFTokensByUnderlying(fTokenMetas);

        const vaultMetas = await getVaultMetas(
          chainId,
          vaultAddrs,
          fTokensByUnderlying,
          resolvers
        );

        vaults[chainId] = vaultMetas;

        // Sort by vaultId so the " 2", " 3" suffixes are deterministic.
        const sortedMetas = Object.values(vaultMetas).sort(
          (a, b) => a.vaultId - b.vaultId
        );
        const pairCounts: Record<string, number> = {};

        for (const meta of sortedMetas) {
          const key = `${FLUID_VAULT}_${meta.vaultId}`;
          const supply = sideLabel(meta.supply, tokens);
          const borrow = sideLabel(meta.borrow, tokens);
          const base = `${supply}-${borrow}`;
          const n = (pairCounts[base] ?? 0) + 1;
          pairCounts[base] = n;
          const suffix = n === 1 ? "" : ` ${n}`;
          names[key] = `Fluid ${base}${suffix}`;
          shortNames[key] = `Fluid ${base}${suffix}`;
        }
      } catch (e) {
        console.log(`Fluid: failed to fetch for chain ${chainId}:`, e);
      }

      if (i < chainEntries.length - 1) {
        await sleep(500);
      }
    }

    return {
      [resolversFile]: FLUID_RESOLVERS,
      [vaultsFile]: vaults,
      [labelsFile]: { names, shortNames },
    };
  }

  mergeData(oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(oldData, data);
  }

  defaults = {};
}
