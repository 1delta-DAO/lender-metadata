import { readFileSync } from "fs";
import { erc20Abi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { mergeData as deepMergeData } from "../../utils.js";
// ============================================================================
// Frankencoin (ZCHF) market registry — the Swiss-franc stablecoin whose borrow
// side is a set of per-position CONTRACTS. An "original" position defines the
// terms (collateral, owner-declared liquidation price, risk premium, reserve
// contribution, expiry) and anyone may permissionlessly CLONE it, so our
// mapping is market = ORIGINAL and sub-account = CLONE.
//
// Roster discovery is hybrid: candidates come from Frankencoin's public API
// (`GET /positions/open` returns the entire book with terms AND live state),
// then EVERY candidate is verified on-chain (owner/collateral/price/limit) and
// on-chain values win — same posture as Inverse and TermMax.
//
// Two filters are load-bearing:
//  1. `version === 2` — MintingHub V1 is dead but still deployed, and its
//     position surface differs. A V1 row must never reach the V2 builders.
//  2. a CURATED COLLATERAL ALLOWLIST — ~40% of the live book is tokenized
//     equity / RWA collateral (BOSS, DQTS, SPYon, REALU, LENDS) that we have
//     no reliable price feed for. Listing a market we cannot price would
//     produce a health factor built on a missing oracle. See
//     FRANKENCOIN_PLAN.md ("Phase 2 — lender, data only").
//
// Only ORIGINALS become markets. Clones are user positions and are discovered
// per-account at request time by margin-fetcher, not stored here.
// ============================================================================
const MARKETS_FILE = "./data/frankencoin-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/frankencoin.json";
const DISPLAY = {
    FRANKENCOIN: { name: "Frankencoin", short: "Frankencoin" },
};
const API_BASE = "https://api.frankencoin.com";
/**
 * Collateral we can price. Everything else is skipped with a log line —
 * widen deliberately, never automatically. Keyed by lowercased address so a
 * symbol collision cannot smuggle an unpriceable asset in.
 */
const COLLATERAL_ALLOWLIST = {
    "1": {
        "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
        "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
        "0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549": "LsETH",
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
        "0x68749665ff8d2d112fa859aa293f07a622782f38": "XAUt",
        "0x45804880de22913dafe09f4980848ece6ecbaf78": "PAXG",
        "0x6810e776880c02933d47db1b9fc05908e5386b96": "GNO",
        "0xd533a949740bb3306d119cc777fa900ba034cd52": "CRV",
    },
};
const POSITION_ABI = [
    {
        type: "function",
        name: "owner",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "collateral",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "price",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "minimumCollateral",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "riskPremiumPPM",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint24" }],
    },
    {
        type: "function",
        name: "reserveContribution",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint24" }],
    },
    {
        type: "function",
        name: "expiration",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint40" }],
    },
    {
        type: "function",
        name: "start",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint40" }],
    },
    {
        type: "function",
        name: "challengePeriod",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint40" }],
    },
    {
        type: "function",
        name: "availableForClones",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "isClosed",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "bool" }],
    },
];
function readConfig() {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
}
async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok)
        throw new Error(`${url}: ${res.status} ${res.statusText}`);
    return await res.json();
}
/** ORIGINAL positions from the API, pre-filtered to V2 + open + allowlisted. */
async function fetchCandidates(chainId) {
    const data = await fetchJson(`${API_BASE}/positions/open`);
    const map = data?.map ?? {};
    const allow = COLLATERAL_ALLOWLIST[chainId] ?? {};
    const out = [];
    let skippedV1 = 0;
    let skippedColl = new Set();
    for (const p of Object.values(map)) {
        if (!p?.isOriginal)
            continue; // clones are user positions, not markets
        if (p?.closed || p?.denied)
            continue;
        if (Number(p?.version) !== 2) {
            skippedV1++;
            continue;
        }
        if (!allow[String(p?.collateral).toLowerCase()]) {
            skippedColl.add(String(p?.collateralSymbol ?? p?.collateral));
            continue;
        }
        out.push(p);
    }
    if (skippedV1 > 0)
        console.log(`Frankencoin: skipped ${skippedV1} non-V2 positions`);
    if (skippedColl.size > 0) {
        console.log(`Frankencoin: skipped unpriceable collateral (not in allowlist): ${[...skippedColl].join(", ")}`);
    }
    return out;
}
async function fetchChain(lender, chainId, cfg) {
    const candidates = await fetchCandidates(chainId);
    if (candidates.length === 0) {
        console.log(`Frankencoin: no eligible originals on chain ${chainId}`);
        return { markets: [] };
    }
    const markets = [];
    for (const cand of candidates) {
        const position = String(cand.position).toLowerCase();
        try {
            // Verify on-chain — the API is only the pointer; these values win.
            const [owner, collateral, price, minimumCollateral, riskPremiumPPM, reserveContribution, expiration, start, challengePeriod, isClosed,] = (await multicallRetryUniversal({
                chain: chainId,
                abi: POSITION_ABI,
                calls: [
                    { address: position, name: "owner", params: [] },
                    { address: position, name: "collateral", params: [] },
                    { address: position, name: "price", params: [] },
                    { address: position, name: "minimumCollateral", params: [] },
                    { address: position, name: "riskPremiumPPM", params: [] },
                    { address: position, name: "reserveContribution", params: [] },
                    { address: position, name: "expiration", params: [] },
                    { address: position, name: "start", params: [] },
                    { address: position, name: "challengePeriod", params: [] },
                    { address: position, name: "isClosed", params: [] },
                ],
                allowFailure: false,
            }));
            if (isClosed) {
                console.log(`Frankencoin: ${position} reads closed on-chain — skipped`);
                continue;
            }
            const collLower = String(collateral).toLowerCase();
            if (collLower !== String(cand.collateral).toLowerCase()) {
                console.log(`Frankencoin: ${position} collateral mismatch vs API — skipped`);
                continue;
            }
            const allow = COLLATERAL_ALLOWLIST[chainId] ?? {};
            if (!allow[collLower]) {
                console.log(`Frankencoin: ${position} on-chain collateral not allowlisted — skipped`);
                continue;
            }
            const [collDecimals, collSymbol] = (await multicallRetryUniversal({
                chain: chainId,
                abi: erc20Abi,
                calls: [
                    { address: collLower, name: "decimals", params: [] },
                    { address: collLower, name: "symbol", params: [] },
                ],
                allowFailure: false,
            }));
            markets.push({
                position,
                collToken: collLower,
                collDecimals: Number(collDecimals),
                collSymbol,
                price: String(price),
                riskPremiumPPM: String(riskPremiumPPM),
                reserveContribution: String(reserveContribution),
                minimumCollateral: String(minimumCollateral),
                limitForClones: String(cand.limitForClones ?? "0"),
                expiration: String(expiration),
                start: String(start),
                challengePeriod: String(challengePeriod),
                version: 2,
                name: `ZCHF / ${collSymbol}`,
            });
        }
        catch (e) {
            console.log(`Frankencoin: ${position} verification failed:`, e?.shortMessage ?? e?.message ?? e);
        }
    }
    return { markets };
}
export class FrankencoinUpdater {
    name = "Frankencoin Markets";
    defaults = {};
    async fetchData() {
        const config = readConfig();
        const lenders = Object.keys(config);
        if (lenders.length === 0) {
            console.log("Frankencoin: no deployments in config/frankencoin.json, skipping");
            return { [MARKETS_FILE]: {} };
        }
        const result = {};
        const names = {};
        const shortNames = {};
        for (const lender of lenders) {
            const disp = DISPLAY[lender] ?? { name: lender, short: lender };
            names[lender] = disp.name;
            shortNames[lender] = disp.short;
            for (const [chainId, cfg] of Object.entries(config[lender])) {
                try {
                    const data = await fetchChain(lender, chainId, cfg);
                    if (!data)
                        continue;
                    if (!result[lender])
                        result[lender] = {};
                    result[lender][chainId] = data;
                    console.log(`Frankencoin: chain ${chainId} → ${data.markets.length} markets`);
                    // Per-market labels — keys are `FRANKENCOIN_<chainId>_<ADDR_HEX_UPPER>`.
                    for (const m of data.markets) {
                        const key = `${lender}_${chainId}_${String(m.position).slice(2).toUpperCase()}`;
                        names[key] = `${disp.name} ${m.name}`;
                        shortNames[key] = `${disp.short} ${m.collSymbol}`;
                    }
                }
                catch (e) {
                    console.log(`Frankencoin: ${lender} chain ${chainId} failed:`, e?.shortMessage ?? e?.message ?? e);
                }
            }
        }
        return {
            [MARKETS_FILE]: result,
            [LABELS_FILE]: { names, shortNames },
        };
    }
    /** Replace per lender+chain when the fetch returned markets; keep the old
     *  roster on an empty result (a failed API call must not wipe the book —
     *  Inverse's posture, and correct here since an empty roster is NOT the
     *  expected steady state as it is for USDD). */
    mergeData(oldData, data, fileKey) {
        if (fileKey === LABELS_FILE) {
            return deepMergeData(oldData ?? {}, data ?? {});
        }
        const merged = { ...(oldData ?? {}) };
        for (const [lender, chains] of Object.entries((data ?? {}))) {
            merged[lender] = { ...(merged[lender] ?? {}) };
            for (const [chainId, chainData] of Object.entries(chains)) {
                if (Array.isArray(chainData?.markets) && chainData.markets.length > 0) {
                    merged[lender][chainId] = chainData;
                }
                else if (!merged[lender][chainId]) {
                    merged[lender][chainId] = chainData ?? { markets: [] };
                }
            }
        }
        return merged;
    }
}
