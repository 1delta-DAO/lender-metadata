// ============================================================================
// Build display labels for Fraxlend pairs.
//
// The roster comes from THIS REPO's `config/fraxlend.json` (the curated pair
// allowlist), and the token SYMBOLS come from the chain.
//
// That split is deliberate. Fraxlend discovery is allowlist-only — the mainnet
// deployer returns 71 pairs of which 12 are FraxlendV1 (a different ABI
// generation) and most of the rest hold single-digit dollars, and the *other*
// mainnet registry is 62 Peapods pod-token pairs, several literally named
// `aspTESTING1`. So the roster must be the curated file. But the file carries
// only `{address, symbol, label}`, and `label` is hand-written, so resolving
// the symbols live keeps a label from drifting away from what the pair
// actually holds. The config `label` is used only as a fallback when a symbol
// read fails.
//
// LABEL SHAPE — `<asset> / <collateral>`, i.e. the borrowable side first:
//
//   names[FRAXLEND_1_<PAIR>]      = "Fraxlend frxUSD / sfrxETH"
//   shortNames[FRAXLEND_1_<PAIR>] = "frxUSD / sfrxETH"
//
// This agrees with BOTH conventions at once, which is why there is no judgement
// call here:
//
//  1. the LlamaLend / TermMax / Teller `<debt> / <collateral>` ordering — on
//     Fraxlend the asset IS the only debt side; and
//  2. Fraxlend's own naming, whose fToken symbols are asset-first
//     (`ffrxUSD(sfrxETH)-58` reads f<ASSET>(<COLLATERAL>)).
//
// Note this is the OPPOSITE of the Curvance labels in this repo, which are
// collateral-first because Curvance's app names them that way and five of its
// markets have two borrowable legs. Fraxlend has exactly one borrowable leg per
// pair, so the ambiguity that forced Curvance's exception does not arise.
//
// DO NOT derive the order by parsing the fToken symbol string — it happens to
// agree today, but a symbol is a display artifact and `asset()` /
// `collateralContract()` are the truth.
//
// SELF-CONTAINED (inline ABI, raw viem) for the same reason as the Curvance
// generator: the published @1delta/abis this repo depends on does not carry
// Fraxlend yet, so importing it would make the generator unrunnable until a
// publish lands.
// ============================================================================
import { createPublicClient, http, fallback } from "viem";
import { mainnet } from "viem/chains";
import { readJsonFile } from "../utils/index.js";
const CONFIG_FILE = "./config/fraxlend.json";
/**
 * Ethereum RPCs, in preference order. Only ~40 reads are needed for the whole
 * roster, so this never approaches a rate limit.
 */
const ETHEREUM_RPCS = [
    "https://gateway.tenderly.co/public/mainnet",
    "https://rpc.mevblocker.io",
    "https://eth.llamarpc.com",
    "https://rpc.flashbots.net",
];
const PAIR_ABI = [
    {
        name: "asset",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        // NOT `collateral()` — that is the Resupply fork's spelling and reverts here.
        name: "collateralContract",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
];
const ERC20_ABI = [
    {
        name: "symbol",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
];
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
/** `FRAXLEND_<chainId>_<PAIR_UPPER>` — mirrors margin-fetcher's lender key. */
export function fraxlendLenderKey(chainId, pair) {
    return `FRAXLEND_${chainId}_${pair.replace(/^0x/i, "").toUpperCase()}`;
}
/**
 * Read the curated roster and resolve each pair's two legs + their symbols.
 *
 * A pair whose legs or symbols cannot be read falls back to the config's
 * hand-written `label`; if that is missing too, the pair is skipped rather than
 * labelled with an address.
 */
export async function discoverFraxlendPairs() {
    const cfg = readJsonFile(CONFIG_FILE);
    const byChain = cfg?.FRAXLEND;
    if (!byChain || typeof byChain !== "object") {
        throw new Error("config/fraxlend.json has no FRAXLEND key");
    }
    const pc = createPublicClient({
        chain: mainnet,
        transport: fallback(ETHEREUM_RPCS.map((u) => http(u))),
    });
    const out = [];
    for (const [chainId, chainData] of Object.entries(byChain)) {
        const listed = (Array.isArray(chainData?.pairs) ? chainData.pairs : []).filter((p) => isAddr(p?.address));
        if (listed.length === 0)
            continue;
        const legs = await pc.multicall({
            contracts: listed.flatMap((p) => [
                {
                    address: p.address,
                    abi: PAIR_ABI,
                    functionName: "asset",
                },
                {
                    address: p.address,
                    abi: PAIR_ABI,
                    functionName: "collateralContract",
                },
            ]),
            allowFailure: true,
        });
        // Resolve the distinct token set once — the same assets recur across pairs.
        const tokens = new Set();
        legs.forEach((r) => {
            if (r.status === "success" && isAddr(r.result))
                tokens.add(r.result.toLowerCase());
        });
        const tokenList = [...tokens];
        const symbols = await pc.multicall({
            contracts: tokenList.map((t) => ({
                address: t,
                abi: ERC20_ABI,
                functionName: "symbol",
            })),
            allowFailure: true,
        });
        const symbolOf = new Map();
        tokenList.forEach((t, i) => {
            const r = symbols[i];
            if (r?.status === "success" && typeof r.result === "string")
                symbolOf.set(t, r.result);
        });
        listed.forEach((p, i) => {
            const asset = legs[i * 2];
            const coll = legs[i * 2 + 1];
            let assetSymbol = asset?.status === "success" && isAddr(asset.result)
                ? symbolOf.get(asset.result.toLowerCase())
                : undefined;
            let collateralSymbol = coll?.status === "success" && isAddr(coll.result)
                ? symbolOf.get(coll.result.toLowerCase())
                : undefined;
            // Fall back to the curated label, which is `<asset> / <collateral>`.
            if ((!assetSymbol || !collateralSymbol) && typeof p.label === "string") {
                const [a, c] = p.label.split("/").map((s) => s.trim());
                assetSymbol ||= a;
                collateralSymbol ||= c;
            }
            if (!assetSymbol || !collateralSymbol) {
                console.warn(`  ~ ${p.address}: could not resolve both legs — skipped`);
                return;
            }
            out.push({
                chainId,
                pair: p.address,
                assetSymbol,
                collateralSymbol,
            });
        });
    }
    return out;
}
/** Build the `names` / `shortNames` records for the discovered pairs. */
export function buildFraxlendLabels(pairs) {
    const names = { FRAXLEND: "Fraxlend" };
    const shortNames = { FRAXLEND: "Fraxlend" };
    for (const p of pairs) {
        const key = fraxlendLenderKey(p.chainId, p.pair);
        const pairName = `${p.assetSymbol} / ${p.collateralSymbol}`;
        names[key] = `Fraxlend ${pairName}`;
        shortNames[key] = pairName;
    }
    return { names, shortNames };
}
