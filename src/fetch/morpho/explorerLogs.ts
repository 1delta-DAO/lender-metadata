// ============================================================================
// Contract logs from a chain's BLOCK EXPLORER index, as an alternative source
// to `eth_getLogs` for the on-chain discovery jobs.
//
// `eventScan.ts` walks the chain through the node, which needs two things a
// public RPC often does not provide: a wide `eth_getLogs` range, and ARCHIVAL
// `eth_getCode` for the deploy-block binary search. On the three Morpho fork
// chains served by Mystic, neither holds (measured 2026-09-07):
//
//   Flare 14      `eth_getLogs` capped at 30 BLOCKS over a 69M-block history,
//                 and the node is pruned — so the deploy-block search converges
//                 near head and the scan completes over an empty recent range,
//                 returning ZERO markets while reporting success.
//   Plume 98866   drpc answers `the method eth_getLogs does not exist`.
//   Citrea 4114   no configured RPC served a getLogs range at all.
//
// A Blockscout instance has already indexed every log, and its Etherscan-shaped
// v1 route answers the whole history in ONE request with no range limit. All
// three chains returned their complete `CreateMarket` set that way (14 / 48 / 5
// events) against the 0 / throw / throw the node path produced.
//
// This is deliberately a NARROW helper: an explorer is a trusted-ish index, not
// a source of truth, so it is used only to ENUMERATE ids that are then read
// back from the chain. Nothing here decides a value.
// ============================================================================

/**
 * Blockscout-family explorers, per chain. Only chains whose node path is known
 * to be unable to serve the scan need an entry — everything else keeps using
 * `eventScan.ts`, which needs no allowlist.
 *
 * Must be a Blockscout instance: the v1 `?module=logs` route is what carries
 * the unbounded block range. Routescan/Etherscan mirrors take an API key and
 * cap ranges, which is the problem we are routing around.
 */
import { withRetry } from "./eventScan.js";

const EXPLORER_LOG_API: Record<string, string> = {
  "14": "https://flare-explorer.flare.network",
  "98866": "https://explorer.plume.org",
  "4114": "https://explorer.mainnet.citrea.xyz",
};

/** Blockscout returns at most this many logs per v1 getLogs response. */
const PAGE_LIMIT = 1000;
/** Guard against an unbounded pagination loop on a misbehaving instance. */
const MAX_PAGES = 50;

export function hasExplorerLogApi(chainId: string): boolean {
  return chainId in EXPLORER_LOG_API;
}

export interface ExplorerLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

/**
 * Every log from `address` matching `topic0`, over the contract's whole
 * history, read from the chain's explorer index.
 *
 * Throws when the chain has no explorer configured or the instance answers
 * something other than a log list — callers should fall back to the node scan
 * rather than treat a failure here as "no markets". An EMPTY result is likewise
 * suspicious for a contract known to exist, so it is returned as-is and the
 * caller decides; see `fetchMorphoMarketsByEvents`.
 */
export async function fetchLogsFromExplorer(
  chainId: string,
  address: string,
  topic0: string,
): Promise<ExplorerLog[]> {
  const base = EXPLORER_LOG_API[chainId];
  if (!base) throw new Error(`no explorer log API for chain ${chainId}`);

  const out: ExplorerLog[] = [];
  const seen = new Set<string>();
  let fromBlock = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${base}/api?module=logs&action=getLogs` +
      `&fromBlock=${fromBlock}&toBlock=latest` +
      `&address=${address}&topic0=${topic0}`;
    // Retried with backoff: these instances drop connections under a handful
    // of concurrent chain jobs, and a bare `fetch failed` there is reported by
    // the caller as "chain unscannable" — which is how Plume and Citrea failed
    // a run whose identical single-chain request succeeded.
    const body = await withRetry(async () => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `explorer ${base} chain ${chainId}: ${res.status} ${res.statusText}`,
        );
      }
      return (await res.json()) as {
        status?: string;
        message?: string;
        result?: unknown;
      };
    });
    // Blockscout reports an empty match as status "0" / "No records found",
    // which is a valid answer, not an error.
    if (!Array.isArray(body.result)) {
      if (body.status === "0") break;
      throw new Error(
        `explorer ${base} chain ${chainId}: unexpected body ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    const batch = body.result as ExplorerLog[];
    let maxBlock = fromBlock;
    for (const log of batch) {
      const block = parseInt(log.blockNumber, 16);
      if (Number.isFinite(block) && block > maxBlock) maxBlock = block;
      // fromBlock is inclusive, so the last block of a page repeats on the
      // next one; dedupe on the full log identity rather than assuming one
      // event per block.
      const key = `${log.blockNumber}:${log.topics?.join(",")}:${log.data}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(log);
    }
    if (batch.length < PAGE_LIMIT) break;
    // A page that did not advance the block cursor cannot be paged past.
    if (maxBlock <= fromBlock) break;
    fromBlock = maxBlock;
  }

  return out;
}
