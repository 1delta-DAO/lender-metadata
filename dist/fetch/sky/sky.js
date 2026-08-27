import { readFileSync } from "fs";
import { erc20Abi, hexToString } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { mergeData as deepMergeData } from "../../utils.js";
// ============================================================================
// Sky (the former MakerDAO / MCD) vault registry — the ORIGINAL dss CDP
// system on Ethereum. Same machinery as the `usdd` provider (Vat / Jug / Spot
// / Dog / DssCdpManager / DssProxyActions / GemJoin), so the whole roster is
// discoverable ON-CHAIN with no API at all.
//
// Curation is unusually clean here: Maker's own `ILK_REGISTRY.info(ilk)`
// returns a `class` field that separates real user-vault collateral from the
// protocol's plumbing. Verified live 2026-08-04 across all 35 registered
// ilks:
//
//   class 1  standard user vaults (Clip auctions)   ~$436M   <- WE TAKE THIS
//   class 3  RWA (permissioned borrowers only)      ~$87M
//   class 4  Teleport (bridge)                      0
//   class 5  Allocator (Spark/Bloom/Obex/...)       ~$5.69B  gem == 0x0
//   class 6  LITE-PSM (swap module)                 ~$5.05B
//   class 7  LockstakeSky (lsSKY staking engine)    ~$157M   join == 0x0
//
// Only class 1 has a real gem + gem-join a user can lock through the CDP
// manager. Class 5/6/7 are not user CDPs at all (allocators and the PSM have
// no gem; the Lockstake engine has its own write surface), and class 3 RWA
// borrowers are permissioned. Filtering on `class === 1` is therefore an
// AUTHORITATIVE, on-chain curation rule — strictly better than the API
// `collateralType` filter USDD needs or the hand-curated allowlist
// Frankencoin needs.
//
// Offboarded ilks are KEPT (WBTC-A/B/C carry `line == 0` with ~13-14% fees).
// They hold real user debt in run-off, and the converter already reports a
// zero ceiling as halted — borrow disabled, repay/withdraw still open, which
// is exactly right for a position a user still needs to exit.
// ============================================================================
const MARKETS_FILE = "./data/sky-markets.json";
const LABELS_FILE = "./data/lender-labels.json";
const CONFIG_FILE = "./config/sky.json";
const DISPLAY = {
    SKY: { name: "Sky", short: "Sky" },
};
/** The only ilk class that is a user-facing vault market. */
const USER_VAULT_CLASS = 1n;
const ILK_REGISTRY_ABI = [
    {
        type: "function",
        name: "list",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "bytes32[]" }],
    },
    {
        type: "function",
        name: "info",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [
            { name: "name", type: "string" },
            { name: "symbol", type: "string" },
            { name: "class", type: "uint256" },
            { name: "dec", type: "uint256" },
            { name: "gem", type: "address" },
            { name: "pip", type: "address" },
            { name: "join", type: "address" },
            { name: "xlip", type: "address" },
        ],
    },
];
const VAT_ABI = [
    {
        type: "function",
        name: "ilks",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [
            { name: "Art", type: "uint256" },
            { name: "rate", type: "uint256" },
            { name: "spot", type: "uint256" },
            { name: "line", type: "uint256" },
            { name: "dust", type: "uint256" },
        ],
    },
];
const SPOT_ABI = [
    {
        type: "function",
        name: "ilks",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [
            { name: "pip", type: "address" },
            { name: "mat", type: "uint256" },
        ],
    },
];
const JUG_ABI = [
    {
        type: "function",
        name: "ilks",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [
            { name: "duty", type: "uint256" },
            { name: "rho", type: "uint256" },
        ],
    },
];
const DOG_ABI = [
    {
        type: "function",
        name: "ilks",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [
            { name: "clip", type: "address" },
            { name: "chop", type: "uint256" },
            { name: "hole", type: "uint256" },
            { name: "dirt", type: "uint256" },
        ],
    },
];
function readConfig() {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
}
/**
 * Positional tuple reader. viem decodes these structs as ARRAYS, and a named
 * lookup like `res.join` silently resolves to `Array.prototype.join` (a
 * function, so `?? res[6]` never fires) — which serialised the string
 * "function join() { [native code] }" into every `gemJoin` on the first run.
 * Always read `info` positionally.
 */
const at = (res, idx) => {
    const v = res?.[idx];
    return typeof v === "function" ? undefined : v;
};
const ilkToString = (b) => {
    try {
        return hexToString(b, { size: 32 }).replace(/[\s\0]+$/g, "");
    }
    catch {
        return "";
    }
};
async function fetchChain(lender, chainId, cfg) {
    // 1. Enumerate every registered ilk from Maker's own registry.
    const [rawList] = (await multicallRetryUniversal({
        chain: chainId,
        abi: ILK_REGISTRY_ABI,
        calls: [{ address: cfg.ilkRegistry, name: "list", params: [] }],
        allowFailure: false,
    }));
    const ilks = rawList ?? [];
    if (ilks.length === 0) {
        console.log(`Sky: ilk registry returned nothing on chain ${chainId}`);
        return { markets: [] };
    }
    // 2. Classify — one multicall over the whole roster.
    const infos = (await multicallRetryUniversal({
        chain: chainId,
        abi: ILK_REGISTRY_ABI,
        calls: ilks.map((i) => ({ address: cfg.ilkRegistry, name: "info", params: [i] })),
        allowFailure: true,
    }));
    const keep = [];
    const skipped = {};
    ilks.forEach((ilk32, i) => {
        const inf = infos[i];
        if (!inf)
            return;
        const cls = BigInt(at(inf, 2) ?? 0);
        const name = ilkToString(ilk32);
        if (cls !== USER_VAULT_CLASS) {
            (skipped[String(cls)] ??= []).push(name);
            return;
        }
        // Legacy PSMs (PSM-USDC-A / PSM-GUSD-A / PSM-PAX-A) are registered as
        // class 1 because they predate the class-6 LITE-PSM convention, but they
        // are swap modules: the position belongs to the PSM contract, no user
        // holds a CDP there. Exclude by name regardless of class.
        if (name.startsWith("PSM-")) {
            (skipped["1(legacy PSM)"] ??= []).push(name);
            return;
        }
        const join = String(at(inf, 6) ?? "");
        const gem = String(at(inf, 4) ?? "");
        // Belt and braces: a class-1 ilk must have a real gem AND gem join.
        if (!join || /^0x0+$/.test(join) || !gem || /^0x0+$/.test(gem)) {
            (skipped["1(no gem/join)"] ??= []).push(name);
            return;
        }
        keep.push({ ilk32, ilk: name, info: inf });
    });
    for (const [cls, names] of Object.entries(skipped)) {
        console.log(`Sky: skipped class ${cls}: ${names.join(", ")}`);
    }
    if (keep.length === 0)
        return { markets: [] };
    // 3. Snapshot the live risk params for the kept ilks.
    const perIlk = 4;
    const params = (await multicallRetryUniversal({
        chain: chainId,
        abi: keep.flatMap(() => [VAT_ABI, SPOT_ABI, JUG_ABI, DOG_ABI]),
        calls: keep.flatMap((k) => [
            { address: cfg.vat, name: "ilks", params: [k.ilk32] },
            { address: cfg.spot, name: "ilks", params: [k.ilk32] },
            { address: cfg.jug, name: "ilks", params: [k.ilk32] },
            { address: cfg.dog, name: "ilks", params: [k.ilk32] },
        ]),
        allowFailure: true,
    }));
    const markets = [];
    for (let i = 0; i < keep.length; i++) {
        const k = keep[i];
        const vat = params[i * perIlk];
        const spot = params[i * perIlk + 1];
        const jug = params[i * perIlk + 2];
        const dog = params[i * perIlk + 3];
        if (!vat || !spot || !jug) {
            console.log(`Sky: ${k.ilk} param read failed — skipped`);
            continue;
        }
        // Drop ilks that are BOTH offboarded and empty: legacy class-1 PSMs
        // (PSM-USDC-A/GUSD/PAX — superseded by the class-6 LITE-PSM) and dead
        // LP-token vaults (GUNIV3*, UNIV2*). No ceiling and no debt means there
        // is no market to quote and no user position to service. Offboarded ilks
        // that still carry debt (the WBTC-A/B/C run-off) are KEPT.
        const ilkDebt = (BigInt(vat.Art ?? vat[0]) * BigInt(vat.rate ?? vat[1])) / 10n ** 45n;
        if (BigInt(vat.line ?? vat[3]) === 0n && ilkDebt === 0n) {
            console.log(`Sky: ${k.ilk} offboarded and empty — dropped`);
            continue;
        }
        const gem = String(at(k.info, 4)).toLowerCase();
        const join = String(at(k.info, 6)).toLowerCase();
        const collDecimals = Number(at(k.info, 3));
        const collSymbol = String(at(k.info, 1));
        // Confirm decimals against the token itself — the registry field has
        // been wrong for exotic gems in the past.
        let onChainDec = collDecimals;
        try {
            const [d] = (await multicallRetryUniversal({
                chain: chainId,
                abi: erc20Abi,
                calls: [{ address: gem, name: "decimals", params: [] }],
                allowFailure: false,
            }));
            onChainDec = Number(d);
        }
        catch {
            /* keep the registry value */
        }
        markets.push({
            ilk: k.ilk,
            gemJoin: join,
            collToken: gem,
            collDecimals: onChainDec,
            collSymbol,
            pip: String(spot.pip ?? spot[0]).toLowerCase(),
            mat: String(spot.mat ?? spot[1]),
            duty: String(jug.duty ?? jug[0]),
            clip: dog ? String(dog.clip ?? dog[0]).toLowerCase() : undefined,
            chop: dog ? String(dog.chop ?? dog[1]) : undefined,
            line: String(vat.line ?? vat[3]),
            dust: String(vat.dust ?? vat[4]),
            /** `line == 0` ⇒ OFFBOARDED: borrowing disabled, repay/withdraw open. */
            offboarded: BigInt(vat.line ?? vat[3]) === 0n,
            /**
             * The ILK is part of the name, not metadata about it.
             *
             * `DAI / WETH` alone is shared by ETH-A, ETH-B and ETH-C — three markets
             * holding $762M, $508M and $12M, rendered identically everywhere this
             * name reaches. They are not variants of one product: the ilk sets the
             * liquidation ratio (`mat`), the stability fee (`duty`) and the debt
             * ceiling (`line`), which is the entire reason Maker mints more than one
             * per collateral. `ETH-A` is also how a Maker user already refers to it.
             */
            name: `DAI / ${k.ilk}`,
        });
    }
    return { markets };
}
export class SkyUpdater {
    name = "Sky (Maker) Vault Markets";
    defaults = {};
    async fetchData() {
        const config = readConfig();
        const lenders = Object.keys(config);
        if (lenders.length === 0) {
            console.log("Sky: no deployments in config/sky.json, skipping");
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
                    const live = data.markets.filter((m) => !m.offboarded).length;
                    console.log(`Sky: chain ${chainId} → ${data.markets.length} class-1 markets (${live} borrowable, ${data.markets.length - live} offboarded)`);
                    for (const m of data.markets) {
                        // `_` is the ONLY separator in a market key — the ilk's own `-`
                        // is re-spelled (`WBTC-A` → `SKY_1_WBTC_A`). A key mixing both
                        // cannot round-trip through a slug/case layer; margin-fetcher's
                        // `dssLenderKey` is the canonical definition. The true ilk is
                        // carried in the row's `ilk` field, so nothing is lost.
                        const key = `${lender}_${chainId}_${m.ilk.replace(/-/g, "_")}`;
                        names[key] = `${disp.name} ${m.name}`;
                        shortNames[key] = `${disp.short} ${m.collSymbol}`;
                    }
                }
                catch (e) {
                    console.log(`Sky: ${lender} chain ${chainId} failed:`, e?.shortMessage ?? e?.message ?? e);
                }
            }
        }
        return {
            [MARKETS_FILE]: result,
            [LABELS_FILE]: { names, shortNames },
        };
    }
    /** Replace per lender+chain when the fetch produced markets; never wipe a
     *  good roster on an empty/failed read (an empty roster is NOT the
     *  expected steady state here, unlike USDD). */
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
