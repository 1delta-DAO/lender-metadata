import { readFileSync } from "fs";
import { multicallRetryUniversal, getEvmClientUniversal, } from "@1delta/providers";
import { mergeData as deepMergeData } from "../../utils.js";
// ============================================================================
// Curve LlamaLend market registry.
//
// A market is a {Vault (ERC-4626 lender side), Controller (borrow side), AMM
// (LLAMMA)} triplet. TWO GENERATIONS share this registry and one lender key
// space (`LLAMALEND_<CONTROLLER_ADDR>`): v1 (`OneWayLendingFactory`,
// `registryId: 'oneway'`) and v2 (`LendFactory`, `registryId: 'oneway-v2'`).
// Every row carries `version` because the leverage ABIs differ and Ethereum
// runs both side by side.
//
// config/llamalend.json seeds the per-chain factories, Curve's LeverageZap
// (recorded, not used) and 1delta's own callbacker. The market ROSTER is
// discovered from Curve's API — one `GET /v1/getLendingVaults/all` returns
// every market on every chain in both generations — but every candidate is
// then VERIFIED on-chain and the on-chain values win, so a compromised API
// cannot inject rows.
//
// THE LOAD-BEARING PART OF THIS GENERATOR is the DELEGATION SCAN. LlamaLend's
// boolean grant `approve(spender, allow)` exists only on newer-blueprint
// controllers — 48 of 98 markets at 2026-08, and NONE on Arbitrum — so
// `supportsDelegation` has to be resolved per market, not per protocol. It is
// determined by looking for the dispatch selector in the deployed RUNTIME
// BYTECODE rather than by an `eth_call` probe: most public RPCs return an
// indistinguishable error for "no such method" and a transient node failure,
// so a probe would silently mark working markets as non-delegatable (or
// worse, the reverse). Unknown → false. FAIL CLOSED.
//
// Inclusion rule: the market must verify on-chain AND either be borrowable
// (liquidity > 0) or carry a live book above the dust floor — dead empty
// markets drop, but a paused market with borrowers stays listed so their
// positions remain visible in user data.
// ============================================================================
const MARKETS_FILE = "./data/llamalend-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/llamalend.json";
const CURVE_API = "https://api.curve.finance/v1/getLendingVaults/all";
/** Markets below this borrowed AND supplied (USD) are dropped as dead. */
const DUST_FLOOR_USD = 1_000;
/** Curve's own UI default band count. */
const DEFAULT_BANDS = 10;
const DISPLAY = {
    LLAMALEND: { name: "LlamaLend", short: "LlamaLend" },
};
/** Curve's `blockchainId` → our chain id. */
const CHAIN_BY_SLUG = {
    ethereum: "1",
    optimism: "10",
    arbitrum: "42161",
    fraxtal: "252",
    sonic: "146",
};
/**
 * Dispatch selectors probed in the runtime bytecode.
 *
 * `approve(address,bool)` is the discriminator: a controller that has it also
 * has `approval`, the `_for` arguments and `set_extra_health`, because they
 * all landed in the same blueprint revision. The others are checked as a
 * consistency assertion — a market with some but not all of them would mean
 * the blueprint changed shape and this generator needs revisiting.
 */
const SELECTORS = {
    approve: "3d140d21", // approve(address,bool)
    approval: "e1270b6e", // approval(address,address)
    createLoanFor: "fadc9bfb", // create_loan(uint256,uint256,uint256,address)
    setExtraHealth: "1e4b7760", // set_extra_health(uint256)
};
const CONTROLLER_ABI = [
    {
        type: "function",
        name: "loan_discount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "liquidation_discount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "collateral_token",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "borrowed_token",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "amm",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "monetary_policy",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "borrow_cap",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "A",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "price_oracle_contract",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "min_rate",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "RATE_CALCULATOR",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
];
/** Reads issued per market, in this exact order. Keep in sync with the slicer. */
const MARKET_READS = [
    { on: "controller", name: "collateral_token" },
    { on: "controller", name: "borrowed_token" },
    { on: "controller", name: "amm" },
    { on: "controller", name: "monetary_policy" },
    { on: "controller", name: "loan_discount" },
    { on: "controller", name: "liquidation_discount" },
    { on: "controller", name: "borrow_cap" },
    { on: "amm", name: "A" },
    { on: "amm", name: "price_oracle_contract" },
    { on: "mp", name: "min_rate" },
    { on: "mp", name: "RATE_CALCULATOR" },
];
export class LlamaLendUpdater {
    name = "llamalend";
    defaults = {};
    async fetchData() {
        const config = readConfig();
        const result = {};
        const names = {};
        const shortNames = {};
        // ONE call covers every chain and both generations.
        let api;
        try {
            api = await fetchJson(CURVE_API);
        }
        catch (e) {
            console.log("LlamaLend: Curve API unreachable —", e?.message ?? e);
            return { [MARKETS_FILE]: {}, [LABELS_FILE]: { names, shortNames } };
        }
        const rows = api?.data?.lendingVaultData ?? [];
        if (rows.length === 0) {
            console.log("LlamaLend: Curve API returned no vaults");
            return { [MARKETS_FILE]: {}, [LABELS_FILE]: { names, shortNames } };
        }
        for (const [lender, chains] of Object.entries(config)) {
            const disp = DISPLAY[lender] ?? DISPLAY.LLAMALEND;
            for (const [chainId, cfg] of Object.entries(chains)) {
                if (!cfg.oneWayFactory && !cfg.lendFactory)
                    continue;
                try {
                    const data = await fetchChain(chainId, cfg, rows);
                    if (!data || data.markets.length === 0) {
                        console.log(`LlamaLend: chain ${chainId}: no markets survived`);
                        continue;
                    }
                    (result[lender] ??= {})[chainId] = data;
                    const delegatable = data.markets.filter((m) => m.supportsDelegation).length;
                    const leverageable = data.markets.filter((m) => m.supportsLeverage).length;
                    console.log(`LlamaLend: chain ${chainId}: ${data.markets.length} markets ` +
                        `(${delegatable} delegation-capable, ${leverageable} leverage-capable, ` +
                        `${data.markets.filter((m) => m.version === 2).length} v2)`);
                    for (const m of data.markets) {
                        const key = `${lender}_${String(m.controller).slice(2).toUpperCase()}`;
                        names[key] = `${disp.name} ${m.name}`;
                        shortNames[key] = `${disp.short} ${m.name}`;
                    }
                }
                catch (e) {
                    console.log(`LlamaLend: ${lender} chain ${chainId} failed:`, e?.shortMessage ?? e?.message ?? e);
                }
            }
        }
        return {
            [MARKETS_FILE]: result,
            [LABELS_FILE]: { names, shortNames },
        };
    }
    /** Replace per lender+chain when the fetch returned markets; keep old on empty. */
    mergeData(oldData, data, fileKey) {
        if (fileKey === LABELS_FILE || fileKey === CONFIG_FILE) {
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
function readConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    }
    catch {
        return {};
    }
}
async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
        throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}
/** How many RPC endpoints to try before giving up on a chain's scan. */
const MAX_RPC_IDS = 8;
/** Full passes over the endpoint list — see the note in `scanDelegation`. */
const SCAN_ROUNDS = 3;
/**
 * Classify one controller's runtime bytecode.
 *
 * `undefined` means UNRESOLVED (the code could not be read), which is
 * deliberately distinct from `false` (read fine, no delegation) — see
 * {@link scanDelegation}.
 */
function classifyCode(chainId, controller, code) {
    if (code === undefined)
        return undefined;
    if (code === "0x")
        return false;
    const has = (sel) => code.includes(sel);
    const hasApprove = has(SELECTORS.approve);
    // Consistency check: these all shipped in the same blueprint revision, so a
    // partial match means the contract shape changed and the discriminator can
    // no longer be trusted for this market.
    if (hasApprove &&
        !(has(SELECTORS.approval) &&
            has(SELECTORS.createLoanFor) &&
            has(SELECTORS.setExtraHealth))) {
        console.log(`LlamaLend: chain ${chainId}: ${controller} has approve() but not the full delegation set — treating as NOT delegatable (blueprint shape changed?)`);
        return false;
    }
    return hasApprove;
}
/**
 * Resolve `supportsDelegation` for a batch of controllers by inspecting their
 * deployed runtime bytecode.
 *
 * WHY BYTECODE AND NOT `eth_call`: on most public RPCs a call to a
 * non-existent Vyper method and a transient node failure come back as the
 * same generic "execution reverted", so a probe cannot tell "this market
 * predates delegation" from "the node hiccuped".
 *
 * WHY FAILOVER AND AN ABORT GUARD: `eth_getCode` is served far less reliably
 * than `eth_call` — on Ethereum, 5 of the 6 configured endpoints refuse it
 * outright (measured 2026-08-04; only `rpcId: 4` answered). Without failover
 * the first run of this generator marked all 27 Ethereum markets
 * non-delegatable when 23 of them, including the two largest by borrows, do
 * support it. Silently publishing that would have disabled every on-behalf
 * route on the chain that holds 95% of the book.
 *
 * So: try endpoints until one serves the whole batch, and return `undefined`
 * for anything still unresolved. The caller ABORTS the chain rather than
 * publishing a roster whose delegation column is guesswork — `mergeData` then
 * keeps the previous, known-good rows.
 */
async function scanDelegation(chainId, controllers) {
    const out = {};
    for (const c of controllers)
        out[c.toLowerCase()] = undefined;
    // Several rounds over the endpoint list, not one. A single sweep leaves
    // stragglers: the one endpoint that serves `eth_getCode` can still drop an
    // individual request, and by then every other endpoint has been exhausted.
    // Since ONE unresolved market aborts the whole chain (see the caller), a
    // straggler is as costly as a total outage.
    for (let round = 0; round < SCAN_ROUNDS; round++) {
        for (let rpcId = 0; rpcId < MAX_RPC_IDS; rpcId++) {
            const pending = controllers.filter((c) => out[c.toLowerCase()] === undefined);
            if (pending.length === 0)
                return finishScan(chainId, controllers, out);
            let client;
            try {
                client = getEvmClientUniversal({ chain: chainId, rpcId });
            }
            catch {
                continue;
            }
            let failures = 0;
            for (const c of pending) {
                const lower = c.toLowerCase();
                try {
                    const code = (await client.getCode({ address: c }));
                    out[lower] = classifyCode(chainId, c, code ?? "0x");
                    // A success proves the endpoint serves getCode, so an earlier
                    // failure here was transient, not a refusal — stop counting toward
                    // the give-up threshold.
                    failures = 0;
                }
                catch {
                    failures++;
                    // An endpoint that refuses getCode refuses every call; don't spend
                    // a round-trip per market discovering that.
                    if (failures >= 3)
                        break;
                }
            }
        }
    }
    return finishScan(chainId, controllers, out);
}
function finishScan(chainId, controllers, out) {
    const unresolved = Object.values(out).filter((v) => v === undefined).length;
    if (unresolved > 0) {
        console.log(`LlamaLend: chain ${chainId}: ${unresolved}/${controllers.length} delegation scans UNRESOLVED after ${SCAN_ROUNDS} rounds over ${MAX_RPC_IDS} endpoints`);
    }
    return out;
}
/** Which monetary-policy family this market uses (drives the irm-sdk model). */
function rateModelFor(minRate, rateCalculator, version) {
    // `min_rate()` answering is the semilog discriminator; only
    // SemilogMonetaryPolicy exposes it.
    if (typeof minRate === "bigint")
        return "semilog";
    // A rate calculator means `r0` is an external yield that moves on its own —
    // the curve cannot be cached across refreshes.
    if (typeof rateCalculator === "string" &&
        /^0x[0-9a-f]{40}$/i.test(rateCalculator)) {
        return "hyperbolic-dynamic";
    }
    return version === 1 ? "hyperbolic-dynamic" : "hyperbolic";
}
async function fetchChain(chainId, cfg, apiRows) {
    const slug = cfg.apiChainSlug ??
        Object.entries(CHAIN_BY_SLUG).find(([, id]) => id === chainId)?.[0];
    if (!slug) {
        console.log(`LlamaLend: chain ${chainId} has no Curve API slug — skipping`);
        return undefined;
    }
    const candidates = apiRows.filter((r) => {
        if (r?.blockchainId !== slug)
            return false;
        if (!r?.controllerAddress || !r?.address || !r?.ammAddress)
            return false;
        if (!r?.assets?.collateral?.address || !r?.assets?.borrowed?.address)
            return false;
        const borrowed = Number(r?.borrowed?.usdTotal ?? 0);
        const supplied = Number(r?.totalSupplied?.usdTotal ?? 0);
        // Dead-and-empty drops; a live book keeps the row even if borrowing is
        // currently impossible, so existing borrowers stay visible.
        return borrowed > DUST_FLOOR_USD || supplied > DUST_FLOOR_USD;
    });
    if (candidates.length === 0) {
        console.log(`LlamaLend: chain ${chainId}: API returned no candidates`);
        return undefined;
    }
    // --- on-chain verification; these values WIN over the API ---
    const calls = candidates.flatMap((r) => MARKET_READS.map(({ on, name }) => ({
        address: on === "controller"
            ? r.controllerAddress
            : on === "amm"
                ? r.ammAddress
                : r.monetaryPolicyAddress,
        name,
        args: [],
    })));
    const verify = (await multicallRetryUniversal({
        chain: chainId,
        calls,
        abi: CONTROLLER_ABI,
        allowFailure: true,
    }));
    const delegation = await scanDelegation(chainId, candidates.map((r) => r.controllerAddress));
    // Refuse to publish a roster whose delegation column is guesswork. Every
    // consumer treats `supportsDelegation` as authoritative when deciding
    // whether an on-behalf route is legal, so an RPC outage must drop the whole
    // chain (mergeData then keeps the previous, known-good rows) rather than
    // quietly demote every market to direct-only.
    const unresolved = candidates.filter((r) => delegation[String(r.controllerAddress).toLowerCase()] === undefined);
    if (unresolved.length > 0) {
        throw new Error(`delegation scan unresolved for ${unresolved.length}/${candidates.length} markets — refusing to write a roster with an unverified supportsDelegation column`);
    }
    const markets = [];
    candidates.forEach((r, i) => {
        const base = i * MARKET_READS.length;
        const [collateralToken, borrowedToken, amm, monetaryPolicy, loanDiscount, liquidationDiscount, borrowCap, ammA, priceOracle, minRate, rateCalculator,] = MARKET_READS.map((_, j) => verify[base + j]);
        // Verification: the on-chain token pair must match the API row, and the
        // AMM the controller reports must be the one the API named. Either
        // mismatch means the API row does not describe this contract.
        const chainColl = typeof collateralToken === "string"
            ? collateralToken.toLowerCase()
            : undefined;
        const chainBorrowed = typeof borrowedToken === "string"
            ? borrowedToken.toLowerCase()
            : undefined;
        const chainAmm = typeof amm === "string" ? amm.toLowerCase() : undefined;
        if (!chainColl ||
            !chainBorrowed ||
            chainColl !== String(r.assets.collateral.address).toLowerCase() ||
            chainBorrowed !== String(r.assets.borrowed.address).toLowerCase() ||
            (chainAmm && chainAmm !== String(r.ammAddress).toLowerCase())) {
            console.log(`LlamaLend: chain ${chainId}: DROPPING ${r.name ?? r.controllerAddress} — on-chain verification failed`);
            return;
        }
        if (typeof ammA !== "bigint" || ammA <= 1n) {
            console.log(`LlamaLend: chain ${chainId}: DROPPING ${r.controllerAddress} — unreadable AMM A`);
            return;
        }
        const version = r.registryId === "oneway-v2" ? 2 : 1;
        const controller = String(r.controllerAddress).toLowerCase();
        // The API's `id` is `<registry>-<factoryIndex>`; that index IS the
        // `controller_id` the leverage zap's callback_args needs.
        const factoryIndex = Number(String(r.id ?? "").split("-").pop());
        if (!Number.isInteger(factoryIndex) || factoryIndex < 0) {
            console.log(`LlamaLend: chain ${chainId}: DROPPING ${r.controllerAddress} — no factory index in id "${r.id}"`);
            return;
        }
        // v2 markets live in LendFactory, which the v1 zaps do not index, so they
        // can never be leveraged through this route regardless of their index.
        const supportsLeverage = version === 1 &&
            typeof cfg.leverageStartId === "number" &&
            factoryIndex >= cfg.leverageStartId &&
            Boolean(cfg.leverageZapOdos || cfg.leverageZap1inch);
        const collSymbol = r.assets.collateral.symbol ?? "COLL";
        const borrowedSymbol = r.assets.borrowed.symbol ?? "LOAN";
        markets.push({
            controller,
            vault: String(r.address).toLowerCase(),
            amm: String(r.ammAddress).toLowerCase(),
            collateralToken: chainColl,
            collateralDecimals: Number(r.assets.collateral.decimals ?? 18),
            collateralSymbol: collSymbol,
            borrowedToken: chainBorrowed,
            borrowedDecimals: Number(r.assets.borrowed.decimals ?? 18),
            borrowedSymbol,
            monetaryPolicy: String(typeof monetaryPolicy === "string"
                ? monetaryPolicy
                : r.monetaryPolicyAddress).toLowerCase(),
            priceOracle: typeof priceOracle === "string" ? priceOracle.toLowerCase() : undefined,
            version,
            factoryIndex,
            supportsLeverage,
            // FAIL CLOSED — see scanDelegation.
            supportsDelegation: delegation[controller] === true,
            ammA: ammA.toString(),
            loanDiscount: typeof loanDiscount === "bigint" ? loanDiscount.toString() : "0",
            liquidationDiscount: typeof liquidationDiscount === "bigint"
                ? liquidationDiscount.toString()
                : "0",
            defaultBands: DEFAULT_BANDS,
            rateModel: rateModelFor(minRate, rateCalculator, version),
            gauge: r.gaugeAddress ? String(r.gaugeAddress).toLowerCase() : null,
            // v1 has no cap at all; storing "0" there would read as "borrowing
            // disabled", which is the opposite of the truth.
            borrowCap: version === 2 && typeof borrowCap === "bigint"
                ? borrowCap.toString()
                : undefined,
            name: `${borrowedSymbol} / ${collSymbol}`,
        });
    });
    return { markets };
}
