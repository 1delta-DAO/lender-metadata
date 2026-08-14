import { sleep } from "../../utils.js";
import { AAVE_V4_HUB_SEED } from "./v4Hubs.js";

export const DEFAULT_GRAPHQL_URL = "https://api.aave.com/graphql";

/**
 * chainId -> hubs on that chain. Mirrors `AAVE_V4_HUB_SEED`, which is the only
 * seed there is: the `config/aave-v4-hubs.json` this module used to load was
 * deleted when the seed moved into code, and reading the missing file is why
 * the peripherals pass silently fetched nothing for every chain.
 */
type HubSeedMap = { [chainId: string]: { hub: string }[] };

export type PositionManagerEntry = {
  name: string;
  address: string;
  active: boolean;
};

export type SpokePeripheralEntry = {
  spokeName: string;
  spokeId: string;
  positionManagers: PositionManagerEntry[];
};

export type HubGateways = {
  nativeGateway?: string;
  signatureGateway?: string;
};

/**
 * Per-chain peripherals, in the shape `config/aave-v4-peripherals.json`
 * actually carries and that `@1delta/data-sdk`'s `AaveV4ChainPeripherals`
 * reads: gateways keyed by HUB, spoke metadata keyed by SPOKE.
 *
 * There is deliberately no fork dimension. It was removed from the data (a
 * spoke can hang off several hubs, so `fork -> hub -> spokes` could not
 * represent the tree) but this fetcher kept emitting it, which is how the
 * peripherals pass came to throw on every run — see the note on
 * `mergeAaveV4PeripheralsData`.
 *
 * Every field is optional because ABSENT and EMPTY are different claims: a
 * deployment with no native gateway (ether.fi's OP instance ships none) must
 * not publish `nativeGateway: ""`, which reads as "there is one, we lost it".
 */
export type ChainPeripherals = {
  nativeGateway?: string;
  signatureGateway?: string;
  /** keyed by lowercase hub address */
  perHub?: Record<string, HubGateways>;
  /** keyed by lowercase spoke address */
  perSpoke?: Record<string, SpokePeripheralEntry>;
};

/** chainId string -> chain peripherals */
export type AaveV4PeripheralsOutput = Record<string, ChainPeripherals>;

/** Drop keys whose value is empty, so absent stays absent in the JSON. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === "") continue;
    if (typeof v === "object" && v !== null && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

/** Stable key ordering for JSON diffs */
export function sortPeripheralsTree(data: AaveV4PeripheralsOutput): AaveV4PeripheralsOutput {
  const out: AaveV4PeripheralsOutput = {};
  const chainKeys = Object.keys(data ?? {}).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
  for (const chain of chainKeys) {
    const c = data[chain];
    if (!c) continue;

    const perHub: Record<string, HubGateways> = {};
    for (const hk of Object.keys(c.perHub ?? {}).sort()) {
      const g = compact({ ...(c.perHub?.[hk] ?? {}) });
      if (Object.keys(g).length > 0) perHub[hk] = g;
    }

    const perSpoke: Record<string, SpokePeripheralEntry> = {};
    for (const sk of Object.keys(c.perSpoke ?? {}).sort()) {
      perSpoke[sk] = c.perSpoke![sk];
    }

    out[chain] = compact({
      nativeGateway: c.nativeGateway,
      signatureGateway: c.signatureGateway,
      perHub,
      perSpoke,
    });
  }
  return out;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function normAddr(a: string): string {
  return a.toLowerCase();
}

function isValidAddr(a: string | undefined): boolean {
  if (!a || typeof a !== "string") return false;
  const x = a.toLowerCase();
  return x.length === 42 && x.startsWith("0x") && x !== ZERO;
}

/**
 * Keep a known gateway rather than let a partial fetch blank it, but return
 * `undefined` — not `""` — when neither side has one. See `ChainPeripherals`.
 */
function pickGateway(
  incoming: string | undefined,
  existing: string | undefined,
): string | undefined {
  if (isValidAddr(incoming)) return normAddr(incoming!);
  if (isValidAddr(existing)) return normAddr(existing!);
  return undefined;
}

/**
 * A name the API supplies that carries no information. Aave's GraphQL returns
 * "Unknown" for every Giver/Taker/Config PM, so it must never overwrite the
 * curated name `update:aave-v4-pm-names` derives from the deployed bytecode.
 */
function isPlaceholderName(name: string | undefined): boolean {
  const n = (name ?? "").trim();
  return n === "" || n.toLowerCase() === "unknown";
}

/**
 * Merge PM rows by lowercase address; incoming fields win on conflict, EXCEPT
 * a placeholder `name`, which never displaces a name already on record.
 */
export function mergePositionManagerLists(
  prev: PositionManagerEntry[],
  next: PositionManagerEntry[],
): PositionManagerEntry[] {
  const merged = new Map<string, PositionManagerEntry>();
  for (const p of prev) {
    const k = normAddr(p.address);
    merged.set(k, { ...p, address: k });
  }
  for (const n of next) {
    const k = normAddr(n.address);
    const existing = merged.get(k);
    if (!existing) {
      merged.set(k, { ...n, address: k });
      continue;
    }
    merged.set(k, {
      ...existing,
      ...n,
      address: k,
      name:
        isPlaceholderName(n.name) && !isPlaceholderName(existing.name) ? existing.name : n.name,
    });
  }
  return [...merged.values()].sort((a, b) => a.address.localeCompare(b.address));
}

function mergeSpokeEntry(
  prev: SpokePeripheralEntry | undefined,
  next: SpokePeripheralEntry,
): SpokePeripheralEntry {
  if (!prev) return next;
  return {
    spokeName: next.spokeName || prev.spokeName,
    spokeId: next.spokeId || prev.spokeId,
    positionManagers: mergePositionManagerLists(prev.positionManagers, next.positionManagers),
  };
}

function mergeHubGateways(
  prev: HubGateways | undefined,
  next: HubGateways | undefined,
): HubGateways {
  return compact({
    nativeGateway: pickGateway(next?.nativeGateway, prev?.nativeGateway),
    signatureGateway: pickGateway(next?.signatureGateway, prev?.signatureGateway),
  });
}

/**
 * Deep merge for persisted peripherals: preserves prior gateways/spokes when a
 * fetch is partial.
 *
 * APPEND-ONLY, and that is load-bearing. Aave's GraphQL API only knows the
 * hubs Aave itself operates, so a whitelabel instance (ether.fi on OP) fetches
 * as an empty chain; and `positionManagers[].name` is overwritten downstream by
 * `update:aave-v4-pm-names`, which classifies by bytecode. Neither may be
 * clobbered by an empty round.
 */
export function mergeAaveV4PeripheralsData(
  oldData: AaveV4PeripheralsOutput,
  newData: AaveV4PeripheralsOutput,
): AaveV4PeripheralsOutput {
  const chains = new Set([...Object.keys(oldData ?? {}), ...Object.keys(newData ?? {})]);
  const result: AaveV4PeripheralsOutput = {};

  for (const chain of chains) {
    const o = oldData?.[chain];
    const n = newData?.[chain];
    if (!o && !n) continue;

    const perHub: Record<string, HubGateways> = {};
    for (const hub of new Set([...Object.keys(o?.perHub ?? {}), ...Object.keys(n?.perHub ?? {})])) {
      const merged = mergeHubGateways(o?.perHub?.[hub], n?.perHub?.[hub]);
      if (Object.keys(merged).length > 0) perHub[hub] = merged;
    }

    const perSpoke: Record<string, SpokePeripheralEntry> = { ...(o?.perSpoke ?? {}) };
    for (const [addr, spoke] of Object.entries(n?.perSpoke ?? {})) {
      perSpoke[addr] = mergeSpokeEntry(perSpoke[addr], spoke);
    }

    result[chain] = {
      nativeGateway: pickGateway(n?.nativeGateway, o?.nativeGateway),
      signatureGateway: pickGateway(n?.signatureGateway, o?.signatureGateway),
      perHub,
      perSpoke,
    };
  }

  return sortPeripheralsTree(result);
}

type GqlError = { message: string };

export async function aaveGql<T>(
  url: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  fetchFn: typeof fetch,
): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: T; errors?: GqlError[] };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (json.data == null) {
    throw new Error("GraphQL response missing data");
  }
  return json.data;
}

const CHAINS_QUERY = `
query Chains($chainIds: [ChainId!]!) {
  chains(request: { query: { chainIds: $chainIds } }) {
    chainId
    nativeGateway
    signatureGateway
  }
}
`;

export const SPOKES_QUERY = `
query Spokes($hub: EvmAddress!, $chainId: ChainId!) {
  spokes(request: { query: { hub: { address: $hub, chainId: $chainId } } }) {
    id
    address
    name
    chain { chainId }
  }
}
`;

const PM_QUERY = `
query SpokePM($spoke: SpokeId!, $pageSize: PageSize!, $cursor: Cursor) {
  spokePositionManagers(request: { spoke: $spoke, pageSize: $pageSize, cursor: $cursor }) {
    items {
      name
      address
      active
    }
    pageInfo {
      next
    }
  }
}
`;

export type FetchV4PeripheralsOptions = {
  graphqlUrl?: string;
  fetchFn?: typeof fetch;
  /** ms between GraphQL calls (default 150) */
  throttleMs?: number;
};

export async function fetchAllPositionManagersForSpoke(
  graphqlUrl: string,
  fetchFn: typeof fetch,
  spokeId: string,
  throttleMs: number,
): Promise<PositionManagerEntry[]> {
  const all: PositionManagerEntry[] = [];
  let cursor: string | null | undefined;

  for (;;) {
    const data = await aaveGql<{
      spokePositionManagers: {
        items: { name: string; address: string; active: boolean }[];
        pageInfo: { next: string | null };
      };
    }>(
      graphqlUrl,
      PM_QUERY,
      {
        spoke: spokeId,
        pageSize: "FIFTY",
        cursor: cursor ?? null,
      },
      fetchFn,
    );

    const items = data.spokePositionManagers?.items ?? [];
    for (const it of items) {
      all.push({
        name: String(it.name ?? ""),
        address: normAddr(it.address),
        active: Boolean(it.active),
      });
    }

    cursor = data.spokePositionManagers?.pageInfo?.next ?? null;
    if (!cursor) break;
    await sleep(throttleMs);
  }

  return mergePositionManagerLists([], all);
}

export async function fetchAaveV4Peripherals(
  hubSeed: HubSeedMap = AAVE_V4_HUB_SEED,
  opts: FetchV4PeripheralsOptions = {},
): Promise<AaveV4PeripheralsOutput> {
  const graphqlUrl = opts.graphqlUrl ?? process.env.AAVE_GRAPHQL_URL ?? DEFAULT_GRAPHQL_URL;
  const fetchFn = opts.fetchFn ?? fetch;
  const throttleMs = opts.throttleMs ?? 150;

  const chainIdStrs = new Set<string>(Object.keys(hubSeed ?? {}));

  const chainIdsNum = [...chainIdStrs].map((c) => Number(c)).filter((n) => !Number.isNaN(n));

  const result: AaveV4PeripheralsOutput = {};

  for (const cid of chainIdStrs) {
    result[cid] = { perHub: {}, perSpoke: {} };
  }

  if (chainIdsNum.length > 0) {
    try {
      const chainData = await aaveGql<{
        chains: { chainId: number; nativeGateway: string; signatureGateway: string }[];
      }>(graphqlUrl, CHAINS_QUERY, { chainIds: chainIdsNum }, fetchFn);
      await sleep(throttleMs);

      const byChainId = new Map<number, { nativeGateway: string; signatureGateway: string }>();
      for (const ch of chainData.chains ?? []) {
        byChainId.set(Number(ch.chainId), {
          nativeGateway: normAddr(ch.nativeGateway),
          signatureGateway: normAddr(ch.signatureGateway),
        });
      }

      for (const cid of chainIdStrs) {
        const n = Number(cid);
        const g = byChainId.get(n);
        if (g) {
          result[cid].nativeGateway = g.nativeGateway;
          result[cid].signatureGateway = g.signatureGateway;
        }
      }
    } catch (e: any) {
      console.error(`[Aave V4 Peripherals] chains query failed: ${e?.message ?? e}`);
    }
  }

  for (const chainIdStr of Object.keys(hubSeed ?? {})) {
    for (const seed of hubSeed[chainIdStr] ?? []) {
      const hubAddr = seed?.hub;
      if (!hubAddr) continue;

      const chainIdNum = Number(chainIdStr);
      if (Number.isNaN(chainIdNum)) {
        console.warn(`[Aave V4 Peripherals] skip invalid chainId: ${chainIdStr}`);
        continue;
      }

      result[chainIdStr] ??= { perHub: {}, perSpoke: {} };

      // Gateways are published per CHAIN by the API; record them against each
      // hub on that chain. A hub the API does not know (a whitelabel instance)
      // gets no entry at all rather than an empty one.
      const hubKey = normAddr(hubAddr);
      const chainGateways = mergeHubGateways(undefined, {
        nativeGateway: result[chainIdStr].nativeGateway,
        signatureGateway: result[chainIdStr].signatureGateway,
      });
      if (Object.keys(chainGateways).length > 0) {
        result[chainIdStr].perHub![hubKey] = chainGateways;
      }

      try {
        const spokeData = await aaveGql<{
          spokes: { id: string; address: string; name: string }[];
        }>(
          graphqlUrl,
          SPOKES_QUERY,
          { hub: hubAddr, chainId: chainIdNum },
          fetchFn,
        );
        await sleep(throttleMs);

        const spokes = spokeData.spokes ?? [];
        for (const sp of spokes) {
          const addrKey = normAddr(sp.address);
          try {
            const pms = await fetchAllPositionManagersForSpoke(
              graphqlUrl,
              fetchFn,
              sp.id,
              throttleMs,
            );
            result[chainIdStr].perSpoke![addrKey] = {
              spokeName: String(sp.name ?? ""),
              spokeId: String(sp.id ?? ""),
              positionManagers: pms,
            };
          } catch (err: any) {
            console.error(
              `[Aave V4 Peripherals] spokePositionManagers failed hub=${hubKey} chain=${chainIdStr} spoke=${addrKey}: ${err?.message ?? err}`,
            );
            result[chainIdStr].perSpoke![addrKey] = {
              spokeName: String(sp.name ?? ""),
              spokeId: String(sp.id ?? ""),
              positionManagers: [],
            };
          }
          await sleep(throttleMs);
        }
      } catch (err: any) {
        console.error(
          `[Aave V4 Peripherals] spokes query failed hub=${hubKey} chain=${chainIdStr}: ${err?.message ?? err}`,
        );
      }
    }
  }

  return sortPeripheralsTree(result);
}
