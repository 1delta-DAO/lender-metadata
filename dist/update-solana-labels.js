// ============================================================================
// Write display labels for the Solana lending markets into
// data/lender-labels.json — the file yield-tracer seeds `lender_metadata`
// (name + logo per lender key, served on `/lending/lenders`) from.
//
// Every Solana family fans out to per-market keys whose suffix is BASE58 and
// case-significant, so the keys are written VERBATIM (UNIFIED_API_PLAN D1):
//
//   names[KAMINO_7u3HeHxY…]            = "Kamino Main Market"
//   shortNames[KAMINO_7u3HeHxY…]       = "Main Market"
//   protocols[KAMINO_7u3HeHxY…]        = "Kamino"
//   names[JUPITER_LEND_main_1]         = "Jupiter Lend SOL / USDC"
//   names[LOOPSCALE_<principal>_<coll>] = "Loopscale JLP / USDC"
//
// The roster and the names come from `@1delta/margin-fetcher-sol` — the same
// fetch yield-tracer's Solana lending job runs — projected through its
// `describeBasket`, so a label always names the basket the rows describe.
//
// Additive: labels for markets no longer listed are left alone, so a user
// still holding a position in a delisted market can read its name.
//
// Usage: `tsx src/update-solana-labels.ts`  (npm run update:solana-labels)
//   SOLANA_LENDERS=KAMINO,SAVE  limit to some families (default: all five)
// ============================================================================
import { SVM_LENDERS, describeBasket, getLenderPublicDataAll, LENDER_BRAND_NAMES, lenderBrandKey,
// TEMPORARY: the sibling lending-sdks build (branch `solana`) until
// @1delta/margin-fetcher-sol and @1delta/svm-kit are published — then these
// become package imports. A `file:` dependency is NOT a substitute: npm
// reifies a linked package's own `workspace:*` deps into its folder and
// wipes the pnpm-managed node_modules there.
 } from "../../lending-sdks/packages/margin-fetcher-sol/dist/index.mjs";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { sortRecord } from "./utils.js";
const LABELS_FILE = "./data/lender-labels.json";
const TOKEN_LIST_URL = "https://raw.githubusercontent.com/1delta-DAO/token-lists/main/solana.json";
async function fetchTokenList() {
    const res = await fetch(TOKEN_LIST_URL);
    if (!res.ok)
        throw new Error(`token list: HTTP ${res.status}`);
    const raw = (await res.json());
    const list = raw?.list ?? raw?.tokens ?? raw;
    const out = {};
    if (Array.isArray(list)) {
        for (const t of list)
            if (t?.address)
                out[t.address] = t;
    }
    else if (list && typeof list === "object") {
        for (const [k, v] of Object.entries(list))
            out[k] = v;
    }
    if (Object.keys(out).length === 0)
        throw new Error("token list: no tokens parsed — refusing to label with mint prefixes");
    return out;
}
/**
 * Symbols for mints the token list does not carry (Loopscale's RWA / long-tail
 * collaterals), from Jupiter's token search — one request per mint, only for
 * labels that would otherwise print a mint prefix.
 */
async function jupiterSymbols(mints) {
    const out = {};
    for (const mint of mints) {
        try {
            const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
            if (!res.ok)
                continue;
            const hits = (await res.json());
            const hit = Array.isArray(hits) ? hits.find((h) => h?.id === mint) : undefined;
            if (hit?.symbol)
                out[mint] = String(hit.symbol);
        }
        catch {
            // cosmetic: a mint without a symbol keeps its prefix
        }
    }
    return out;
}
async function main() {
    const families = (process.env.SOLANA_LENDERS?.split(",") ?? SVM_LENDERS)
        .map((s) => s.trim())
        .filter(Boolean);
    const tokenList = await fetchTokenList();
    // no `rpc`: margin-fetcher-sol's default pool (the measured public roster)
    const bundles = await getLenderPublicDataAll("solana", families, {
        tokenList,
    });
    const keys = Object.keys(bundles);
    if (keys.length === 0) {
        // Fail LOUDLY: zero markets is an API / RPC problem, never a delisting of
        // five protocols at once, and an empty write would look correct.
        console.error("Solana: the fetch returned no markets — refusing to write labels.");
        process.exit(1);
    }
    const names = {};
    const shortNames = {};
    const protocols = {};
    // the bare family keys
    for (const family of families) {
        const brand = LENDER_BRAND_NAMES[family] ?? family;
        names[family] = brand;
        shortNames[family] = brand;
        protocols[family] = brand;
    }
    // the mints a basket would name by prefix: rows with no symbol from the list
    const unresolved = new Set();
    for (const key of keys)
        for (const row of Object.values(bundles[key].data))
            if (!tokenList[row.underlying]?.symbol && !/^[A-Za-z0-9.$+-]{1,16}$/.test(row.asset?.symbol ?? ""))
                unresolved.add(row.underlying);
    const extra = await jupiterSymbols([...unresolved]);
    for (const key of keys)
        for (const row of Object.values(bundles[key].data))
            if (extra[row.underlying] && row.asset)
                row.asset.symbol = extra[row.underlying];
    for (const key of keys) {
        const bundle = bundles[key];
        const basket = describeBasket(key, {
            data: bundle.data,
            params: bundle.params,
        });
        const brand = LENDER_BRAND_NAMES[lenderBrandKey(key)] ?? basket.brandName;
        names[key] = `${brand} ${basket.name}`.trim();
        shortNames[key] = basket.name;
        protocols[key] = brand;
    }
    const labels = readJsonFile(LABELS_FILE) ?? {};
    labels.names ??= {};
    labels.shortNames ??= {};
    labels.protocols ??= {};
    Object.assign(labels.names, names);
    Object.assign(labels.shortNames, shortNames);
    Object.assign(labels.protocols, protocols);
    labels.names = sortRecord(labels.names);
    labels.shortNames = sortRecord(labels.shortNames);
    labels.protocols = sortRecord(labels.protocols);
    const res = await writeTextIfChanged(LABELS_FILE, JSON.stringify(labels, null, 2) + "\n");
    const byFamily = {};
    for (const k of keys) {
        const f = lenderBrandKey(k);
        byFamily[f] = (byFamily[f] ?? 0) + 1;
    }
    console.log(`Solana labels: ${keys.length} market label(s) (${res})`, byFamily);
    process.exit(0);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
