import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { fetchTellerPoolsOnChain } from "./teller/pools.js";

const poolsFile = "./data/teller-pools.json";

/**
 * Rebuild data/teller-pools.json with token metadata read from each pool
 * ON-CHAIN (the Teller middleware API's token addresses/decimals are
 * unreliable). Pool addresses come from the existing file; tokens, decimals,
 * symbols, marketId and maxLoanDuration are overwritten with on-chain truth.
 */
export class TellerPoolsUpdater implements DataUpdater {
  name = "Teller Pools";

  async fetchData(): Promise<Partial<any>> {
    const data = await fetchTellerPoolsOnChain();
    return { [poolsFile]: data };
  }

  /** Replace wholesale — stale token metadata would be misleading. */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
