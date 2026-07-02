import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, symbolsMatch, toAddr } from "../oracle-classifier/normalize.js";
const eulerVaultsFile = "./data/euler-vaults.json";
/** Euler uses address(840) (ISO-4217 USD) as the unit-of-account sentinel for USD. */
const USD_SENTINEL = "0x0000000000000000000000000000000000000348";
const VAULT_ABI = [
    { inputs: [], name: "oracle", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "unitOfAccount", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "asset", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
];
const ROUTER_ABI = [
    {
        inputs: [{ type: "address" }, { type: "address" }],
        name: "getConfiguredOracle",
        outputs: [{ type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
];
// Euler oracle adapters expose name() plus base()/quote() (the end-to-end pair),
// feed() for terminal Chainlink/Pyth/Redstone adapters, and cross() for CrossAdapters.
const ADAPTER_ABI = [
    { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "base", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "quote", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "feed", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "cross", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
];
function numeraireSymbol(uoa, symbols) {
    if (uoa.toLowerCase() === USD_SENTINEL)
        return "USD";
    return symbols.get(uoa.toLowerCase()) ?? null;
}
export async function classifyEulerOracles() {
    const eulerVaults = readJsonFile(eulerVaultsFile);
    // flatten EULER_V2 (and any other forks) into chain -> vault list
    const byChain = new Map();
    for (const byChainMap of Object.values(eulerVaults)) {
        for (const [chainId, list] of Object.entries(byChainMap)) {
            if (!byChain.has(chainId))
                byChain.set(chainId, []);
            for (const v of list)
                byChain.get(chainId).push(v.vault.toLowerCase());
        }
    }
    const result = {};
    for (const [chainId, vaultsRaw] of byChain.entries()) {
        const vaults = [...new Set(vaultsRaw)];
        console.log(`Euler oracles [${chainId}]: ${vaults.length} vaults`);
        // 1. vault -> oracle(router), unitOfAccount, asset, symbol
        const vaultRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: vaults.flatMap((v) => [
                { address: v, name: "oracle", args: [] },
                { address: v, name: "unitOfAccount", args: [] },
                { address: v, name: "asset", args: [] },
                { address: v, name: "symbol", args: [] },
            ]),
            abi: VAULT_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const infos = [];
        vaults.forEach((vault, i) => {
            const router = toAddr(vaultRes[4 * i]);
            const uoa = vaultRes[4 * i + 1];
            const asset = toAddr(vaultRes[4 * i + 2]);
            const symbol = asString(vaultRes[4 * i + 3]);
            // escrow / uninitialized vaults have no router or unit of account
            if (!router || !asset || typeof uoa !== "string")
                return;
            infos.push({ vault, router, uoa: uoa.toLowerCase(), asset, symbol });
        });
        if (infos.length === 0)
            continue;
        // 2. configured adapter per (router, asset, uoa); router name() for context
        const triplets = [
            ...new Map(infos.map((it) => [`${it.router}|${it.asset}|${it.uoa}`, it])).values(),
        ];
        const adapterRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: triplets.map((t) => ({
                address: t.router,
                name: "getConfiguredOracle",
                args: [t.asset, t.uoa],
            })),
            abi: ROUTER_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const adapterByTriplet = new Map();
        triplets.forEach((t, i) => adapterByTriplet.set(`${t.router}|${t.asset}|${t.uoa}`, toAddr(adapterRes[i])));
        // 3. adapter details
        const adapters = [
            ...new Set([...adapterByTriplet.values()].filter((a) => !!a)),
        ];
        const adapterDetailRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: adapters.flatMap((a) => [
                { address: a, name: "name", args: [] },
                { address: a, name: "base", args: [] },
                { address: a, name: "quote", args: [] },
                { address: a, name: "feed", args: [] },
                { address: a, name: "cross", args: [] },
            ]),
            abi: ADAPTER_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const adapterInfo = new Map();
        adapters.forEach((a, i) => {
            adapterInfo.set(a, {
                name: asString(adapterDetailRes[5 * i]),
                base: toAddr(adapterDetailRes[5 * i + 1]),
                quote: toAddr(adapterDetailRes[5 * i + 2]),
                feed: toAddr(adapterDetailRes[5 * i + 3]),
                cross: toAddr(adapterDetailRes[5 * i + 4]),
            });
        });
        // 4. resolve symbols (assets, unit-of-account tokens, adapter base/quote/cross)
        const symAddrs = new Set();
        for (const it of infos) {
            symAddrs.add(it.asset);
            if (it.uoa !== USD_SENTINEL)
                symAddrs.add(it.uoa);
        }
        for (const a of adapterInfo.values()) {
            for (const x of [a.base, a.quote, a.cross])
                if (x)
                    symAddrs.add(x);
        }
        const symList = [...symAddrs];
        const symRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: symList.map((a) => ({ address: a, name: "symbol", args: [] })),
            abi: SYMBOL_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const symbols = new Map();
        symList.forEach((a, i) => symbols.set(a, asString(symRes[i])));
        const symOf = (addr) => {
            if (!addr)
                return null;
            if (addr.toLowerCase() === USD_SENTINEL)
                return "USD";
            return symbols.get(addr.toLowerCase()) ?? null;
        };
        // 5. resolve terminal feed descriptions (Chainlink aggregators behind adapters)
        const feeds = [
            ...new Set([...adapterInfo.values()].map((a) => a.feed).filter((f) => !!f)),
        ];
        const feedGraph = await probeFeedGraph(chainId, feeds);
        // 6. build per-vault entries
        result[chainId] = {};
        for (const it of infos) {
            const adapter = adapterByTriplet.get(`${it.router}|${it.asset}|${it.uoa}`) ?? null;
            const ai = adapter ? adapterInfo.get(adapter) : undefined;
            const numeraire = numeraireSymbol(it.uoa, symbols);
            const baseSymbol = symOf(ai?.base ?? null);
            const quoteSymbol = symOf(ai?.quote ?? null);
            const crossSymbol = symOf(ai?.cross ?? null);
            const provider = ai?.name ?? null;
            const isFixed = !!provider && /fixedrate/i.test(provider);
            const feedDescription = ai?.feed ? resolveFeed(ai.feed, feedGraph).priceDescription : null;
            const priceDescription = baseSymbol && quoteSymbol
                ? `${baseSymbol} / ${quoteSymbol}`
                : feedDescription && feedDescription !== "UNKNOWN"
                    ? feedDescription
                    : "UNKNOWN";
            const assetSymbol = symOf(it.asset);
            const intendedPair = assetSymbol && numeraire ? `${assetSymbol} / ${numeraire}` : null;
            // correctOracle: does the adapter price the intended asset? (base match)
            // denominatorMatch: is it denominated in the vault's unit of account? (quote match)
            const verifiable = !isFixed && !!adapter && !!baseSymbol && !!quoteSymbol;
            const correctOracle = verifiable && assetSymbol ? symbolsMatch(baseSymbol, assetSymbol) : null;
            const denominatorMatch = verifiable && numeraire ? symbolsMatch(quoteSymbol, numeraire) : null;
            result[chainId][it.vault] = {
                vault: it.vault,
                vaultSymbol: it.symbol,
                asset: it.asset,
                assetSymbol,
                router: it.router,
                adapter,
                provider,
                unitOfAccount: it.uoa,
                numeraire,
                base: ai?.base ?? null,
                baseSymbol,
                quote: ai?.quote ?? null,
                quoteSymbol,
                cross: ai?.cross ?? null,
                crossSymbol,
                priceDescription,
                feed: ai?.feed ?? null,
                feedDescription,
                fixedRate: isFixed ? true : null,
                intendedPair,
                correctOracle,
                denominatorMatch,
            };
        }
    }
    return result;
}
