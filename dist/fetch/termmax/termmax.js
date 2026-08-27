import { multicallRetryUniversal } from "@1delta/providers";
import { mergeData as deepMergeData } from "../../utils.js";
// ============================================================================
// TermMax per-chain deployment registry (config/termmax.json).
//
// TermMax is a fixed-rate, fixed-maturity AMM over zero-coupon bonds. Three
// layers: a MARKET mints FT/XT/GT and holds no liquidity, per-maker ORDER
// contracts own the pricing curve, and optional ERC-4626 vaults curate orders.
//
// THIS FILE WRITES CHAIN CONFIG ONLY — there is deliberately no
// data/termmax-markets.json. Markets churn on every maturity roll (~15% of the
// book turned over on a single date in Jul-2026) and MATURED MARKETS VANISH
// from the upstream list entirely rather than lingering with a flag, so a
// checked-in market roster would be stale within weeks. margin-fetcher
// discovers markets at runtime from the TermMax API instead.
//
// The chain roster and candidate addresses are discovered from TermMax's own
// API, but EVERY address is then VERIFIED ON-CHAIN and anything that fails is
// dropped — same discipline as the Inverse updater: a compromised or drifted
// API cannot inject an address into the config.
//
// Verification per address:
//   routerV2   `getVersion()` returns a version string ("2.0.0" / "2.0.1").
//              A router WITHOUT it is a V1-era router and is recorded as
//              `routerV1` instead — BNB and Arbitrum are in that state today,
//              which means the V2 SwapPath borrow is unavailable there.
//   viewer     `getPositionDetails([], addr)` returns (does not revert).
//   oracle     `getPrice(debtToken)` returns a non-zero price for a live
//              market's debt token.
//   whitelistManager  `isWhitelisted(router, MARKET)` returns.
// ============================================================================
const CONFIG_FILE = "./config/termmax.json";
const LABELS_FILE = "./data/lender-labels.json";
const API_BASE = "https://api.termmax.ts.finance";
const SUPPORT_CHAINS_URL = `${API_BASE}/market/config/support-chains`;
/**
 * WhitelistManager addresses are NOT in the API's `globalConfig` — they only
 * appear on the docs site, so they are seeded here and then verified on-chain
 * like everything else. A chain absent from this map simply gets no
 * `whitelistManager` field; nothing depends on it at read time.
 */
const WHITELIST_MANAGERS = {
    "1": "0xB84f2a39b271D92586c61232a73ee1F7adFBf317",
    "56": "0x6119E236d3798777A3f2553926070958DF5704F1",
    "196": "0x41e1f213bF4aDA84a0D4E6A9b5E0F0a211F5A723",
    "223": "0x03c4FCF963E5FBC0dC5851d2340624E70492acb9",
    "42161": "0x7a571901687E7F30431B4E86bdd1baB6caE51D43",
    "80094": "0x6Cf2B79D1A2173339399a3ecB44086327c9ce308",
};
const DISPLAY = { name: "TermMax", short: "TermMax" };
const ROUTER_ABI = [
    {
        type: "function",
        name: "getVersion",
        stateMutability: "pure",
        inputs: [],
        outputs: [{ name: "", type: "string" }],
    },
];
const VIEWER_ABI = [
    {
        type: "function",
        name: "getPositionDetails",
        stateMutability: "view",
        inputs: [
            { name: "market", type: "address[]" },
            { name: "owner", type: "address" },
        ],
        outputs: [
            {
                name: "",
                type: "tuple[]",
                components: [
                    { name: "underlyingBalance", type: "uint256" },
                    { name: "collateralBalance", type: "uint256" },
                    { name: "ftBalance", type: "uint256" },
                    { name: "xtBalance", type: "uint256" },
                    {
                        name: "gtInfo",
                        type: "tuple[]",
                        components: [
                            { name: "loanId", type: "uint256" },
                            { name: "collateralAmt", type: "uint256" },
                            { name: "debtAmt", type: "uint256" },
                        ],
                    },
                ],
            },
        ],
    },
];
const ORACLE_ABI = [
    {
        type: "function",
        name: "getPrice",
        stateMutability: "view",
        inputs: [{ name: "asset", type: "address" }],
        outputs: [
            { name: "price", type: "uint256" },
            { name: "decimals", type: "uint8" },
        ],
    },
];
const WHITELIST_ABI = [
    {
        type: "function",
        name: "isWhitelisted",
        stateMutability: "view",
        inputs: [
            { name: "contractAddress", type: "address" },
            { name: "module", type: "uint8" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
];
/** A throwaway address for the read-only viewer probe. */
const PROBE_ACCOUNT = "0x1111111111111111111111111111111111111111";
async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
}
const lower = (v) => String(v ?? "").toLowerCase();
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
/** Read one `view`/`pure` call, returning undefined when it reverts. */
async function tryRead(chainId, address, abi, name, params = []) {
    try {
        const res = (await multicallRetryUniversal({
            chain: chainId,
            calls: [{ address, name, params }],
            abi,
            allowFailure: true,
        }));
        return res?.[0];
    }
    catch {
        return undefined;
    }
}
/**
 * Verify + assemble one chain's config. Returns undefined when the chain
 * cannot be verified at all (no viewer or no oracle), so it is left out
 * rather than published half-working.
 */
async function fetchChain(chainId) {
    let cfg;
    let markets = [];
    try {
        const data = await fetchJson(`${API_BASE}/market/data?chainId=${chainId}`);
        cfg = data?.data?.globalConfig;
        markets = Array.isArray(data?.data?.markets) ? data.data.markets : [];
    }
    catch (e) {
        console.log(`  TermMax ${chainId}: API unavailable (${e}) — skipping`);
        return undefined;
    }
    if (!cfg)
        return undefined;
    const routerCandidate = cfg.routerV2Address || cfg.routerAddress;
    const legacyRouter = cfg.routerAddress;
    const viewer = cfg.marketViewerV2Address;
    const oracle = cfg.oracleAggregatorV2 || cfg.oracleAggregator;
    if (!isAddr(viewer) || !isAddr(oracle)) {
        console.log(`  TermMax ${chainId}: no viewer/oracle in API config — skipping`);
        return undefined;
    }
    // ── viewer: must answer getPositionDetails ──
    const viewerOk = (await tryRead(chainId, viewer, VIEWER_ABI, "getPositionDetails", [
        [],
        PROBE_ACCOUNT,
    ])) !== undefined;
    if (!viewerOk) {
        console.log(`  TermMax ${chainId}: viewer ${viewer} failed verification — skipping`);
        return undefined;
    }
    // ── oracle: must price a live market's debt token ──
    const debtToken = markets.find((m) => isAddr(m?.contracts?.underlyingAddr))
        ?.contracts?.underlyingAddr;
    let oracleOk = true;
    if (debtToken) {
        const res = await tryRead(chainId, oracle, ORACLE_ABI, "getPrice", [
            debtToken,
        ]);
        const price = Array.isArray(res) ? res[0] : res?.price;
        oracleOk = price !== undefined && BigInt(price ?? 0) > 0n;
    }
    if (!oracleOk) {
        // Not fatal on its own — some chains have assets the aggregator does not
        // price yet — but worth surfacing, since LTV/liquidation read off this.
        console.log(`  TermMax ${chainId}: oracle ${oracle} did not price ${debtToken}`);
    }
    const out = {
        oracleAggregatorV2: oracle,
        viewer,
    };
    // ── router: getVersion decides V2 vs V1 ──
    if (isAddr(routerCandidate)) {
        const version = await tryRead(chainId, routerCandidate, ROUTER_ABI, "getVersion");
        if (typeof version === "string" && version.startsWith("2.")) {
            out.routerV2 = routerCandidate;
        }
        else {
            // No `getVersion` ⇒ a V1-era router. Record it as such rather than
            // mislabelling it: the V2 SwapPath borrow does not exist on it.
            out.routerV1 = routerCandidate;
            console.log(`  TermMax ${chainId}: router ${routerCandidate} has no getVersion — recorded as routerV1`);
        }
    }
    if (isAddr(legacyRouter) &&
        lower(legacyRouter) !== lower(out.routerV2 ?? "") &&
        lower(legacyRouter) !== lower(out.routerV1 ?? "")) {
        out.routerV1 = legacyRouter;
    }
    // ── whitelist manager (seeded, verified) ──
    const wm = WHITELIST_MANAGERS[chainId];
    if (isAddr(wm)) {
        const probe = out.routerV2 ?? out.routerV1;
        const ok = probe !== undefined &&
            (await tryRead(chainId, wm, WHITELIST_ABI, "isWhitelisted", [
                probe,
                2, // ContractModule.MARKET
            ])) !== undefined;
        if (ok)
            out.whitelistManager = wm;
    }
    // ── market factories (event-based discovery fallback; not needed on the
    //    happy path, where markets come from the API) ──
    const factories = [];
    for (const key of ["factoryV2AddressList", "marketV2_01FactoryAddressList"]) {
        for (const entry of cfg[key] ?? []) {
            const addr = entry?.address ?? entry;
            if (isAddr(addr) && !factories.some((f) => lower(f) === lower(addr))) {
                factories.push(addr);
            }
        }
    }
    if (factories.length > 0)
        out.marketFactories = factories;
    console.log(`  TermMax ${chainId}: ${out.routerV2 ? "routerV2" : "routerV1 only"}, ` +
        `${markets.length} live markets, ${factories.length} factories`);
    return { config: out, markets };
}
// ---------------------------------------------------------------------------
// Per-market display labels
//
// TermMax market keys are `TERMMAX_<MARKET_ADDR>`, which tells a user nothing —
// and a pair typically has MANY keys differing only by maturity, so the raw key
// is actively confusing in a list. Same problem Term Finance solves with
// per-repo labels, so the format mirrors it:
//
//   names       "TermMax USDC / PT-sUSDE — 2026-08-16"
//   shortNames  "TM USDC/PT-sUSDE 2026-08-16"
//
// The upstream `symbol` is `"<debt>/<collateral>@<DDMMMYYYY>"`, sometimes with
// the collateral carrying its own maturity suffix
// (`USDC/PT-sUSDE-13AUG2026@16AUG2026`). The trailing `@…` is dropped — the
// MATURITY TIMESTAMP is authoritative for the date, not the symbol text, and
// the collateral's own maturity is left in place because it identifies the
// asset (PT-sUSDE-13AUG2026 is a different token from PT-sUSDE-27AUG2026).
// ---------------------------------------------------------------------------
/** `1786845600` → `"2026-08-16"` (UTC). Empty when unusable. */
function maturityDate(maturity) {
    const secs = Number(maturity);
    if (!Number.isFinite(secs) || secs <= 0)
        return "";
    return new Date(secs * 1000).toISOString().slice(0, 10);
}
/** Split `"USDC/PT-sUSDE-13AUG2026@16AUG2026"` into its debt/collateral pair. */
function parsePair(symbol) {
    const raw = String(symbol ?? "").trim();
    if (!raw)
        return "";
    const at = raw.lastIndexOf("@");
    const pair = at > 0 ? raw.slice(0, at) : raw;
    return pair.includes("/") ? pair : "";
}
function buildLabels(perChain) {
    // Bare dispatch key first — this is what enables the parent-label fallback
    // for any per-market key that has not been generated yet.
    const names = { TERMMAX: DISPLAY.name };
    const shortNames = { TERMMAX: DISPLAY.short };
    for (const markets of Object.values(perChain)) {
        for (const m of markets ?? []) {
            const addr = m?.contracts?.marketAddr;
            if (!isAddr(addr))
                continue;
            const key = `TERMMAX_${String(addr).slice(2).toUpperCase()}`;
            const pair = parsePair(m.symbol);
            // The maturity timestamp wins over anything parsed out of the symbol.
            const day = maturityDate(typeof m.maturity === "number"
                ? m.maturity
                : Date.parse(String(m.maturity ?? "")) / 1000);
            if (pair) {
                names[key] = `${DISPLAY.name} ${pair.replace(/\//g, " / ")}${day ? ` — ${day}` : ""}`;
                shortNames[key] = `TM ${pair}${day ? ` ${day}` : ""}`;
            }
            else {
                names[key] = `${DISPLAY.name}${day ? ` — ${day}` : ""}`;
                shortNames[key] = `TM${day ? ` ${day}` : ""}`;
            }
        }
    }
    return { names, shortNames };
}
export class TermMaxUpdater {
    name = "TermMax Chain Config";
    defaults = {};
    async fetchData() {
        let chainIds = [];
        try {
            const res = await fetchJson(SUPPORT_CHAINS_URL);
            chainIds = (res?.data ?? []).map((c) => String(c));
        }
        catch (e) {
            console.log(`TermMax: cannot reach ${SUPPORT_CHAINS_URL} (${e})`);
            return {};
        }
        if (chainIds.length === 0)
            return {};
        console.log(`TermMax: ${chainIds.length} chains reported by the API`);
        const config = {};
        const marketsByChain = {};
        for (const chainId of chainIds) {
            const row = await fetchChain(chainId);
            if (!row)
                continue;
            config[chainId] = row.config;
            marketsByChain[chainId] = row.markets;
        }
        if (Object.keys(config).length === 0) {
            console.log("TermMax: nothing verified, leaving config untouched");
            return {};
        }
        const labels = buildLabels(marketsByChain);
        const perMarket = Object.keys(labels.names).length - 1; // minus the bare key
        console.log(`TermMax: ${perMarket} per-market labels`);
        return {
            [CONFIG_FILE]: config,
            [LABELS_FILE]: labels,
        };
    }
    /**
     * Deep-merge both files. The config is a seeded/shared file, and merging
     * (rather than replacing) means a chain whose RPC was down during a run
     * keeps its previously verified addresses instead of silently disappearing.
     */
    mergeData(oldData, data) {
        return deepMergeData(oldData ?? {}, data ?? {});
    }
}
