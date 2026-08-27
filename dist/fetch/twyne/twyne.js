import { readFileSync } from "fs";
import { multicallRetryUniversal, getEvmClientUniversal, } from "@1delta/providers";
import { mergeData as deepMergeData } from "../../utils.js";
// ============================================================================
// Twyne market registry.
//
// Twyne is a CREDIT DELEGATION layer over Aave V3 and Euler V2 — capital never
// leaves the underlying protocol. A market is a whitelisted triple
// `(intermediateVault, targetVault, targetAsset)`:
//
//   * the INTERMEDIATE ("credit") vault is an unmodified Euler EVK EVault whose
//     asset is a RECEIPT token — `eWETH` on the Euler side, a Twyne ERC-20
//     wrapper around an Aave `aToken` on the Aave side. Credit-LPs deposit
//     there and their idle borrowing power is what borrowers reserve;
//   * `targetVault` is where the debt is taken (an Euler eVault, or the Aave V3
//     Pool) and `targetAsset` is what is borrowed.
//
// WHY THIS GENERATOR EXISTS: the roster is NOT discoverable by a getter.
// `VaultManager` keeps `isIntermediateVault` / `isAllowedTargetAssets` as
// un-enumerable mappings and governance whitelists by multisig, so the ONLY
// complete source is the event log — `T_SetIntermediateVault`,
// `T_AddAllowedTargetVault`, `T_AddAllowedTargetVaultAsset` — replayed in order
// (a later `T_SetIntermediateVault(iv, false)` retires a vault) and then
// verified on-chain. Everything published here is re-checked against the chain;
// an event that no longer verifies is dropped.
//
// Two things this scan gets right that the DOCS do not:
//   * the on-chain-addresses page lists THREE intermediate vaults; SIX are
//     registered;
//   * it lists a deleverage operator (`0x229fE10b…`) that has not been used —
//     every live leverage-down runs through `0x37d5c87b…`, which the page does
//     not mention at all. Both are carried in config, the live one first.
//
// LTV IS A BAND, NOT A NUMBER. Each position picks its own `twyneLiqLTV`,
// bounded by `extLiqLTV * externalLiqBuffer <= chosen <= maxTwyneLTVs`. Both
// bounds are governance-set with a linear ramp-down, and the EXTERNAL bound
// moves on its own — Aave's PT eMode thresholds ramp as a PT ages. So the
// values written here are a SNAPSHOT for display and validation; a consumer
// sizing a real action must re-read them.
// ============================================================================
const MARKETS_FILE = "./data/twyne-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/twyne.json";
/** `VaultType` as the factory's enum orders it. */
const VAULT_TYPE = { EULER_V2: 0, AAVE_V3: 1 };
const DISPLAY = { TWYNE: { name: "Twyne", short: "Twyne" } };
const VAULT_MANAGER_EVENTS = [
    {
        type: "event",
        name: "T_SetIntermediateVault",
        inputs: [
            { name: "intermediateVault", type: "address", indexed: true },
            { name: "value", type: "bool", indexed: false },
        ],
    },
    {
        type: "event",
        name: "T_AddAllowedTargetVault",
        inputs: [
            { name: "intermediateVault", type: "address", indexed: true },
            { name: "targetVault", type: "address", indexed: true },
        ],
    },
    {
        type: "event",
        name: "T_AddAllowedTargetVaultAsset",
        inputs: [
            { name: "intermediateVault", type: "address", indexed: true },
            { name: "targetVault", type: "address", indexed: true },
            { name: "targetAsset", type: "address", indexed: true },
        ],
    },
];
const READ_ABI = [
    // EVK intermediate vault
    { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { type: "function", name: "interestRateModel", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    // Twyne aToken wrapper
    { type: "function", name: "aToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    // Pendle PT (only present when the collateral underlying is a PT)
    { type: "function", name: "expiry", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    // VaultManager
    {
        type: "function",
        name: "isIntermediateVault",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "isAllowedTargetVault",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "address" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "isAllowedTargetAssets",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "maxTwyneLTVs",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint16" }],
    },
    {
        type: "function",
        name: "externalLiqBuffers",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint16" }],
    },
    // CollateralVaultFactory
    {
        type: "function",
        name: "collateralVaultBeacon",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "categoryId",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
        outputs: [{ type: "uint8" }],
    },
];
function readConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    }
    catch {
        return {};
    }
}
const lower = (a) => a.toLowerCase();
/** `TWYNE_<chainId>_<INTERMEDIATE_VAULT>_<TARGET_ASSET>`, hex upper-cased. */
const marketKey = (chainId, iv, targetAsset) => `TWYNE_${chainId}_${iv.replace(/^0x/i, "").toUpperCase()}_${targetAsset
    .replace(/^0x/i, "")
    .toUpperCase()}`;
/**
 * Replay the VaultManager's whitelist events into the live triple set.
 *
 * Order matters: `T_SetIntermediateVault(iv, false)` retires an intermediate
 * vault and every triple under it, so the events cannot be treated as a set.
 */
async function scanTriples(chainId, vaultManager) {
    let logs = [];
    let lastErr;
    // A FULL-HISTORY, topic-filtered `eth_getLogs` in one request is exactly what
    // most free endpoints refuse — and they refuse it in three different ways:
    // `Method not found`, a range cap, or (worst) an EMPTY result with no error.
    // So rotate widely, treat an empty result as a failure rather than an answer,
    // and let an operator pin a known-good archival endpoint. `TWYNE_RPC_URL_<chainId>`
    // wins, then `TWYNE_RPC_URL`, then the shared provider rotation.
    const pinned = process.env[`TWYNE_RPC_URL_${chainId}`] ?? process.env.TWYNE_RPC_URL;
    const clients = [];
    if (pinned) {
        const { createPublicClient, http } = await import("viem");
        clients.push(createPublicClient({ transport: http(pinned) }));
    }
    for (let rpcId = 0; rpcId < 8; rpcId++) {
        try {
            clients.push(getEvmClientUniversal({ chain: chainId, rpcId }));
        }
        catch {
            /* fewer RPCs configured than probed — not an error */
        }
    }
    for (const client of clients) {
        try {
            logs = await client.getLogs({
                address: vaultManager,
                events: VAULT_MANAGER_EVENTS,
                fromBlock: 0n,
                toBlock: "latest",
            });
            if (logs.length)
                break;
            lastErr = new Error("empty result (endpoint silently truncated the range)");
        }
        catch (e) {
            lastErr = e;
        }
    }
    if (!logs.length) {
        throw new Error(`Twyne: VaultManager whitelist scan returned nothing across ${clients.length} endpoints (${lastErr?.shortMessage ?? lastErr?.message ?? "empty result"}). Refusing to publish an empty roster.`);
    }
    const activeIvs = new Set();
    const targetVaults = new Map(); // iv -> targetVaults
    const triples = new Map();
    for (const log of logs) {
        const a = log.args ?? {};
        if (log.eventName === "T_SetIntermediateVault") {
            const iv = lower(a.intermediateVault);
            if (a.value)
                activeIvs.add(iv);
            else
                activeIvs.delete(iv);
        }
        else if (log.eventName === "T_AddAllowedTargetVault") {
            const iv = lower(a.intermediateVault);
            if (!targetVaults.has(iv))
                targetVaults.set(iv, new Set());
            targetVaults.get(iv).add(lower(a.targetVault));
        }
        else if (log.eventName === "T_AddAllowedTargetVaultAsset") {
            const iv = lower(a.intermediateVault);
            const tv = lower(a.targetVault);
            triples.set(`${iv}|${tv}|${lower(a.targetAsset)}`, {
                iv,
                tv,
                asset: lower(a.targetAsset),
            });
        }
    }
    // An Euler-side market whitelists only the (iv, targetVault) PAIR — the debt
    // asset is the target vault's own asset, so no `…TargetVaultAsset` event is
    // ever emitted for it. Fold those pairs in, resolving the asset on chain.
    const eulerPairs = [];
    for (const [iv, tvs] of targetVaults) {
        for (const tv of tvs) {
            const alreadyTripled = [...triples.values()].some((t) => t.iv === iv && t.tv === tv);
            if (!alreadyTripled)
                eulerPairs.push({ iv, tv });
        }
    }
    return { activeIvs, triples: [...triples.values()], eulerPairs };
}
async function fetchChain(chainId, cfg) {
    const { activeIvs, triples, eulerPairs } = await scanTriples(chainId, cfg.vaultManager);
    // NOTE `multicallRetryUniversal` returns RAW VALUES (undefined on failure),
    // not viem's `{ status, result }` wrappers — a failed read is `undefined`.
    const ok = (v) => v !== undefined && v !== null;
    // Resolve the Euler pairs' debt asset (= the target eVault's own asset).
    const eulerAssets = eulerPairs.length
        ? (await multicallRetryUniversal({
            chain: chainId,
            calls: eulerPairs.map((p) => ({
                address: p.tv,
                name: "asset",
                args: [],
            })),
            abi: READ_ABI,
            allowFailure: true,
        }))
        : [];
    const candidates = [
        ...triples.map((t) => ({
            iv: t.iv,
            tv: t.tv,
            asset: t.asset,
            // Only the Aave integration whitelists a (vault, asset) pair — the Pool
            // serves many assets, an eVault serves exactly one.
            vaultType: "AAVE_V3",
        })),
        ...eulerPairs.flatMap((p, i) => {
            const a = eulerAssets[i];
            const asset = typeof a === "string" ? lower(a) : undefined;
            // No asset means the target vault did not answer `asset()` — drop the
            // pair rather than publishing a market with an unknown debt token.
            return asset
                ? [{ iv: p.iv, tv: p.tv, asset, vaultType: "EULER_V2" }]
                : [];
        }),
    ].filter((c) => activeIvs.has(c.iv));
    if (!candidates.length)
        return undefined;
    // --- verify every candidate on chain, and enrich -------------------------
    const ivs = [...new Set(candidates.map((c) => c.iv))];
    const ivReads = (await multicallRetryUniversal({
        chain: chainId,
        calls: ivs.flatMap((iv) => [
            { address: iv, name: "asset", args: [] },
            { address: iv, name: "symbol", args: [] },
            { address: iv, name: "interestRateModel", args: [] },
            { address: cfg.vaultManager, name: "maxTwyneLTVs", args: [iv] },
            { address: cfg.vaultManager, name: "externalLiqBuffers", args: [iv] },
            { address: cfg.vaultManager, name: "isIntermediateVault", args: [iv] },
        ]),
        abi: READ_ABI,
        allowFailure: true,
    }));
    const ivInfo = new Map();
    ivs.forEach((iv, i) => {
        const o = i * 6;
        ivInfo.set(iv, {
            collateralAsset: ok(ivReads[o]) ? lower(ivReads[o]) : undefined,
            symbol: ivReads[o + 1],
            irm: ok(ivReads[o + 2]) ? lower(ivReads[o + 2]) : undefined,
            maxTwyneLiqLTV: ok(ivReads[o + 3]) ? Number(ivReads[o + 3]) : undefined,
            externalLiqBuffer: ok(ivReads[o + 4]) ? Number(ivReads[o + 4]) : undefined,
            registered: Boolean(ivReads[o + 5]),
        });
    });
    // Collateral asset → its underlying (+ the aToken it wraps, on Aave).
    const collAssets = [
        ...new Set([...ivInfo.values()].map((v) => v.collateralAsset).filter(Boolean)),
    ];
    const collReads = (await multicallRetryUniversal({
        chain: chainId,
        calls: collAssets.flatMap((c) => [
            { address: c, name: "asset", args: [] },
            { address: c, name: "aToken", args: [] },
            { address: c, name: "symbol", args: [] },
        ]),
        abi: READ_ABI,
        allowFailure: true,
    }));
    const collInfo = new Map();
    collAssets.forEach((c, i) => {
        const o = i * 3;
        collInfo.set(c, {
            underlying: ok(collReads[o]) ? lower(collReads[o]) : undefined,
            // Only the Aave wrapper answers this; an eToken does not, and its
            // `undefined` is how we tell the two integrations apart downstream.
            aToken: ok(collReads[o + 1]) ? lower(collReads[o + 1]) : undefined,
            symbol: collReads[o + 2],
        });
    });
    // Underlyings: maturity (PT collateral) — absent on wstETH/WETH, which is
    // the signal that the market is NOT fixed-term.
    const underlyings = [
        ...new Set([...collInfo.values()].map((v) => v.underlying).filter(Boolean)),
    ];
    const maturityReads = (await multicallRetryUniversal({
        chain: chainId,
        calls: underlyings.flatMap((u) => [
            { address: u, name: "expiry", args: [] },
            { address: u, name: "symbol", args: [] },
        ]),
        abi: READ_ABI,
        allowFailure: true,
    }));
    const underInfo = new Map();
    underlyings.forEach((u, i) => {
        const o = i * 2;
        underInfo.set(u, {
            maturity: ok(maturityReads[o]) ? Number(maturityReads[o]) : undefined,
            symbol: maturityReads[o + 1],
        });
    });
    // The DEBT asset's symbol. A Twyne market is a PAIR — one credit vault backs
    // several debt assets (the Euler eWETH vault backs USDC, USDT and WBTC) — so
    // a label built from the collateral alone names three different markets
    // identically, and a user picking one cannot tell what they would be
    // borrowing. This is the earn-identity rule applied to the lender side.
    const targetAssets = [...new Set(candidates.map((c) => c.asset))];
    const targetReads = (await multicallRetryUniversal({
        chain: chainId,
        calls: targetAssets.map((a) => ({ address: a, name: "symbol", args: [] })),
        abi: READ_ABI,
        allowFailure: true,
    }));
    const targetSymbol = new Map();
    targetAssets.forEach((a, i) => {
        targetSymbol.set(lower(a), ok(targetReads[i]) ? String(targetReads[i]) : undefined);
    });
    // Per-candidate: still whitelisted? eMode category? beacon for the target?
    const perMarket = (await multicallRetryUniversal({
        chain: chainId,
        calls: candidates.flatMap((c) => {
            const coll = ivInfo.get(c.iv)?.collateralAsset ?? c.iv;
            return c.vaultType === "AAVE_V3"
                ? [
                    {
                        address: cfg.vaultManager,
                        name: "isAllowedTargetAssets",
                        args: [c.iv, c.tv, c.asset],
                    },
                    {
                        address: cfg.collateralVaultFactory,
                        name: "categoryId",
                        args: [c.tv, coll, c.asset],
                    },
                    {
                        address: cfg.collateralVaultFactory,
                        name: "collateralVaultBeacon",
                        args: [c.tv],
                    },
                ]
                : [
                    {
                        address: cfg.vaultManager,
                        name: "isAllowedTargetVault",
                        args: [c.iv, c.tv],
                    },
                    { address: cfg.collateralVaultFactory, name: "collateralVaultBeacon", args: [c.tv] },
                    { address: cfg.collateralVaultFactory, name: "collateralVaultBeacon", args: [c.tv] },
                ];
        }),
        abi: READ_ABI,
        allowFailure: true,
    }));
    const markets = [];
    candidates.forEach((c, i) => {
        const o = i * 3;
        const allowed = Boolean(perMarket[o]);
        const iv = ivInfo.get(c.iv);
        if (!allowed || !iv?.registered || !iv.collateralAsset)
            return;
        const coll = collInfo.get(iv.collateralAsset) ?? {};
        const und = coll.underlying ? underInfo.get(coll.underlying) : undefined;
        markets.push({
            key: marketKey(chainId, c.iv, c.asset),
            vaultType: c.vaultType,
            intermediateVault: c.iv,
            targetVault: c.tv,
            targetAsset: c.asset,
            collateralAsset: iv.collateralAsset,
            underlyingAsset: coll.underlying,
            ...(coll.aToken ? { aToken: coll.aToken } : {}),
            ...(c.vaultType === "AAVE_V3" && ok(perMarket[o + 1])
                ? { categoryId: Number(perMarket[o + 1]) }
                : {}),
            ...(ok(perMarket[o + 2]) ? { beacon: lower(perMarket[o + 2]) } : {}),
            maxTwyneLiqLTV: iv.maxTwyneLiqLTV,
            externalLiqBuffer: iv.externalLiqBuffer,
            ...(iv.irm ? { creditIrm: iv.irm } : {}),
            // Present ONLY when the collateral is fixed-term. Its absence is
            // meaningful: it says the market has no maturity, not that we failed to
            // read one.
            ...(und?.maturity ? { collateralMaturity: und.maturity } : {}),
            symbol: und?.symbol ?? coll.symbol ?? iv.symbol,
            // COLLATERAL / DEBT, then the external venue.
            //
            // Collateral first, deliberately, and the opposite of `llamalend-markets`
            // (`crvUSD / WETH` = borrowed / collateral): a LlamaLend market is
            // identified by what it lends, a Twyne market by the CREDIT VAULT it
            // reserves from — which is the collateral side, and is what the market
            // key is built out of. Flipping it here would make the label disagree
            // with the key.
            //
            // The debt half is what makes the label an IDENTITY: without it the three
            // Euler eWETH markets are all "WETH / Euler V2".
            name: `${und?.symbol ?? coll.symbol ?? "?"} / ${targetSymbol.get(lower(c.asset)) ?? "?"} · ${c.vaultType === "AAVE_V3" ? "Aave V3" : "Euler V2"}`,
        });
    });
    // D1's guard: the key drops the target vault, which is safe only while no two
    // triples share (intermediateVault, targetAsset). Fail loudly rather than
    // publish a roster where one key means two different debt venues.
    const byKey = new Map();
    for (const m of markets) {
        const triple = `${m.intermediateVault}|${m.targetVault}|${m.targetAsset}`;
        const seen = byKey.get(m.key);
        if (seen && seen !== triple) {
            throw new Error(`Twyne: key ${m.key} maps to two triples (${seen} / ${triple}). ` +
                `The target vault must go back into the key.`);
        }
        byKey.set(m.key, triple);
    }
    return { markets };
}
export class TwyneUpdater {
    name = "twyne";
    defaults = {};
    async fetchData() {
        const config = readConfig();
        const result = {};
        const names = {};
        const shortNames = {};
        for (const [lender, chains] of Object.entries(config)) {
            const disp = DISPLAY[lender] ?? DISPLAY.TWYNE;
            for (const [chainId, cfg] of Object.entries(chains)) {
                if (!cfg?.vaultManager || !cfg?.collateralVaultFactory)
                    continue;
                try {
                    const data = await fetchChain(chainId, cfg);
                    if (!data || data.markets.length === 0) {
                        console.log(`Twyne: chain ${chainId}: no markets survived`);
                        continue;
                    }
                    (result[lender] ??= {})[chainId] = data;
                    for (const m of data.markets) {
                        names[m.key] = `${disp.name} ${m.name}`;
                        shortNames[m.key] = disp.short;
                    }
                    const fixedTerm = data.markets.filter((m) => m.collateralMaturity).length;
                    console.log(`Twyne: chain ${chainId}: ${data.markets.length} markets ` +
                        `(${fixedTerm} fixed-term collateral), ` +
                        `${new Set(data.markets.map((m) => m.intermediateVault)).size} credit vaults`);
                }
                catch (e) {
                    // Never publish a partial roster: a failed scan must leave the
                    // previous, known-good rows in place (mergeData keeps them).
                    console.log(`Twyne: chain ${chainId} failed —`, e?.message ?? e);
                }
            }
            names[lender] = disp.name;
            shortNames[lender] = disp.short;
        }
        return { [MARKETS_FILE]: result, [LABELS_FILE]: { names, shortNames } };
    }
    /**
     * Replace per lender+chain when the scan returned markets; keep the previous
     * roster otherwise. With no built-in seed in data-sdk, publishing an empty
     * chain would take the whole lender dark on a transient RPC failure.
     */
    mergeData(oldData, data, fileKey) {
        if (fileKey === LABELS_FILE || fileKey === CONFIG_FILE) {
            return deepMergeData(oldData ?? {}, data ?? {});
        }
        const merged = { ...(oldData ?? {}) };
        for (const [lender, chains] of Object.entries((data ?? {}))) {
            merged[lender] = { ...(merged[lender] ?? {}) };
            for (const [chainId, chainData] of Object.entries(chains)) {
                if (chainData?.markets?.length) {
                    merged[lender][chainId] = chainData;
                }
            }
        }
        return merged;
    }
}
