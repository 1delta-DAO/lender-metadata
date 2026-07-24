import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { classifyTellerOracles } from "./teller/classifyOracles.js";

const oraclesClassifiedFile = "./data/teller-oracles-classified.json";

/**
 * Classify Teller's per-pool DEX price oracles (Uniswap-V3 TWAP routes on V2,
 * pluggable price adapters on V3) + evaluate their manipulation resistance.
 * Unlike the Chainlink-based lenders, Teller prices token/token (principal per
 * collateral) via a DEX, so the classification records the pool/adapter, the
 * TWAP window, and whether any route uses manipulable spot `slot0()`.
 */
export class TellerOracleDataUpdater implements DataUpdater {
  name = "Teller Oracle Classification";

  async fetchData(): Promise<Partial<any>> {
    const data = await classifyTellerOracles();
    return { [oraclesClassifiedFile]: data };
  }

  /** Replace wholesale — keeping stale pool keys would be misleading. */
  mergeData(_oldData: any, data: any, _fileKey: string): Partial<any> {
    return mergeData(data ?? {}, {});
  }

  defaults = {};
}
