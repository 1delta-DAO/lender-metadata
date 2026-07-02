// ============================================================================
// Backfill labels for Morpho Blue markets that the allocator API knows about
// but data/lender-labels.json has no name for (the API then falls back to the
// generic "Morpho Blue" name).
//
// For each such market id it reads `idToMarketParams(id)` on the Morpho core
// plus the loan/collateral `symbol()` on-chain, then writes the name in the
// existing convention:  "Morpho <collateral>-<loan> <lltv%>"  /  "MB ...".
//
// Usage: `tsx src/update-morpho-missing-labels.ts [chains] [maxRiskScore]`
// (defaults: chains=1, maxRiskScore=6).
// ============================================================================
import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { numberToBps, sortRecord } from "./utils.js";
const LABELS_FILE = "./data/lender-labels.json";
const ADDRESSES_FILE = "./config/morpho-addresses.json";
const API = "https://portal.1delta.io/v1/data/lending/lenders";
const KEY_PREFIX = "MORPHO_BLUE_";
const CORE_ABI = parseAbi([
    "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);
const unwrap = (r) => r && typeof r === "object" && "result" in r ? r.result : r;
/**
 * Resolve token `symbol()`s on `chainId`. Tries the provider's multicall first;
 * for any token left unresolved (e.g. a chain whose default RPCs return empty
 * data) it retries via the configured public fallback RPCs. Returns a lowercase
 * address → symbol map.
 */
async function readSymbols(chainId, tokens) {
    const symbolOf = new Map();
    if (tokens.length === 0)
        return symbolOf;
    const apply = (res) => tokens.forEach((t, i) => {
        if (symbolOf.has(t))
            return;
        const s = unwrap(res[i]);
        if (typeof s === "string" && s)
            symbolOf.set(t, s);
    });
    try {
        apply((await multicallRetryUniversal({
            chain: chainId,
            calls: tokens.map((address) => ({ address, name: "symbol", args: [] })),
            abi: SYMBOL_ABI,
            allowFailure: true,
        })));
    }
    catch {
        /* leave unresolved */
    }
    return symbolOf;
}
const toParams = (p) => {
    if (!p)
        return null;
    const loanToken = String(p.loanToken ?? p[0] ?? "").toLowerCase();
    const collateralToken = String(p.collateralToken ?? p[1] ?? "").toLowerCase();
    const lltv = p.lltv ?? p[4];
    if (!/^0x[0-9a-f]{40}$/.test(loanToken) || !/^0x[0-9a-f]{40}$/.test(collateralToken))
        return null;
    return { loanToken, collateralToken, lltv };
};
/**
 * Read `idToMarketParams(id)` for every id on `chainId`, index-aligned with
 * `ids`. Markets whose params don't resolve are left `null`.
 */
async function readMarketParams(chainId, core, ids) {
    const out = ids.map(() => null);
    try {
        const res = (await multicallRetryUniversal({
            chain: chainId,
            calls: ids.map((id) => ({ address: core, name: "idToMarketParams", args: [id] })),
            abi: CORE_ABI,
            allowFailure: true,
        }));
        ids.forEach((_, i) => (out[i] = toParams(unwrap(res[i]))));
    }
    catch {
        /* leave unresolved */
    }
    return out;
}
/** Markets the API serves with the generic fallback name, grouped by chainId. */
async function fetchUnnamed(chains, maxRiskScore) {
    const url = `${API}?chains=${chains}&maxRiskScore=${maxRiskScore}`;
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`Allocator API ${res.status} ${res.statusText}`);
    const json = await res.json();
    const items = json?.data?.items ?? [];
    const labels = readJsonFile(LABELS_FILE);
    const names = labels.names ?? {};
    const byChain = {};
    for (const it of items) {
        const key = String(it?.lenderInfo?.key ?? "");
        if (!key.startsWith(KEY_PREFIX))
            continue;
        // Already labelled in our metadata → nothing to do.
        if (names[key])
            continue;
        const chainId = String(it?.chainId ?? "");
        (byChain[chainId] ??= []).push(key);
    }
    return byChain;
}
async function main() {
    const [chainsArg, riskArg] = process.argv.slice(2);
    const chains = chainsArg || "1";
    const maxRiskScore = riskArg || "6";
    const byChain = await fetchUnnamed(chains, maxRiskScore);
    const total = Object.values(byChain).reduce((a, l) => a + l.length, 0);
    console.log(`Found ${total} unnamed Morpho markets across ${Object.keys(byChain).length} chain(s)`);
    const addresses = readJsonFile(ADDRESSES_FILE);
    const labels = readJsonFile(LABELS_FILE);
    labels.names ??= {};
    labels.shortNames ??= {};
    let added = 0;
    const skipped = [];
    for (const [chainId, keys] of Object.entries(byChain)) {
        const core = addresses[chainId]?.morpho;
        if (!core) {
            console.warn(`chain ${chainId}: no Morpho core in config; skipping`);
            skipped.push(...keys);
            continue;
        }
        const ids = keys.map((k) => `0x${k.slice(KEY_PREFIX.length).toLowerCase()}`);
        let parsed;
        let symbolOf;
        try {
            parsed = await readMarketParams(chainId, core, ids);
            const tokenSet = new Set();
            for (const m of parsed)
                if (m)
                    tokenSet.add(m.loanToken), tokenSet.add(m.collateralToken);
            symbolOf = await readSymbols(chainId, [...tokenSet]);
        }
        catch (err) {
            console.warn(`chain ${chainId}: on-chain read failed: ${err?.message ?? err}`);
            skipped.push(...keys);
            continue;
        }
        for (let i = 0; i < keys.length; i++) {
            const m = parsed[i];
            const collSym = m && symbolOf.get(m.collateralToken);
            const loanSym = m && symbolOf.get(m.loanToken);
            if (!m || !collSym || !loanSym) {
                skipped.push(keys[i]);
                continue;
            }
            const bps = numberToBps(m.lltv);
            labels.names[keys[i]] = `Morpho ${collSym}-${loanSym} ${bps}`;
            labels.shortNames[keys[i]] = `MB ${collSym}-${loanSym} ${bps}`;
            added++;
            console.log(`  ${keys[i].slice(0, 24)}… -> ${labels.names[keys[i]]}`);
        }
    }
    labels.names = sortRecord(labels.names);
    labels.shortNames = sortRecord(labels.shortNames);
    const writeResult = await writeTextIfChanged(LABELS_FILE, JSON.stringify(labels, null, 2) + "\n");
    console.log(`Added ${added} labels; file ${writeResult}.`);
    if (skipped.length) {
        console.warn(`Skipped ${skipped.length} (no on-chain params/symbols): ${skipped.map((k) => k.slice(0, 20)).join(", ")}`);
    }
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
