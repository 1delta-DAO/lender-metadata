// ============================================================================
// Rebuild data/lista-collateral-providers.json — the SHAPE roster for every
// per-market collateral provider on Lista/Moolah.
//
// WHY THIS FILE EXISTS
// --------------------
// Moolah gates collateral on a per-market provider: when
// `providers(id, collateralToken)` is non-zero, only that contract may call
// `supplyCollateral` / `withdrawCollateral`, and on withdraw the receiver must
// be the provider itself. Our encoders learned that from the slisBNB/WBNB
// providers, which expose the SAME selectors as Moolah — so "route the Morpho
// call at the provider instead of the pool" was enough.
//
// That assumption is FALSE for Lista's SmartLP markets. Their provider is a
// different contract (`SmartProvider`) that zaps a two-coin PancakeSwap-style
// StableSwap pool:
//
//   supplyCollateral(mp, onBehalf, amount0, amount1, minLp)          0x2f1a11e1
//   withdrawCollateral(mp, coll, min0, min1, onBehalf, receiver)     0xc51638b4
//   withdrawCollateralOneCoin(mp, coll, i, minOut, onBehalf, recv)   0x5c16d49f
//
// versus Moolah's `supplyCollateral(mp, assets, onBehalf, bytes)` (0x238d6579)
// and `withdrawCollateral(mp, assets, onBehalf, receiver)` (0x8720316d). The
// two shapes share a NAME and nothing else, so the wrong one is not a partial
// failure — it is a call to a selector the contract does not implement, which
// reverts with empty data. The collateral token cannot rescue it either: the
// SmartLP receipt is `onlyMoolah`-transferable and minter-only-mintable, so a
// user can never hold or approve it, and the deposit's real inputs are the two
// POOL COINS.
//
// Nothing on-chain announces which shape a provider has, and a wrong guess in
// the optimistic direction ships calldata that reverts for every user of the
// market — the LlamaLend `supportsDelegation` situation. Hence a generated
// roster, and a runtime that FAILS CLOSED on a provider it does not know.
//
// WHAT IS AND IS NOT IN HERE
// --------------------------
// Only facts that outlive a block. `TOKEN` is a constructor immutable;
// `dex` / `dexInfo` / `dexLP` are assigned once in `initialize` and have no
// setter (a UUPS upgrade is the only way to move them, which is exactly the
// event that should re-run this generator); a StableSwap pool's `coins` and
// their decimals never change. Prices, `get_virtual_price`, pool balances and
// LP amounts are runtime reads and deliberately absent.
//
// The market -> provider MAPPING is also absent on purpose: the Lista lens
// already returns `collateralProvider` per market on every public-data fetch,
// and Moolah's owner can re-point it. Runtime takes the provider from the lens
// and looks its SHAPE up here, so a new market on a known provider needs no
// metadata publish at all — only a new provider does.
//
// Run: `npm run update:lista-collateral-providers`
// ============================================================================
import { createPublicClient, fallback, getAddress, http, zeroAddress, } from "viem";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
const MARKETS_FILE = "./config/morpho-type-markets.json";
const POOLS_FILE = "./config/morpho-pools.json";
const NATIVE_PROVIDERS_FILE = "./data/lista-providers.json";
const OUT_FILE = "./data/lista-collateral-providers.json";
const FORK = "LISTA_DAO";
/** The BNB/ETH sentinel a SmartProvider pool uses for the native coin. */
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** Same endpoint order as `providers/src/chains`, kept literal (self-contained). */
const RPCS = {
    "1": [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/eth",
    ],
    "56": [
        "https://bsc-rpc.publicnode.com",
        "https://bsc-dataseed.binance.org",
        "https://rpc.ankr.com/bsc",
    ],
};
const MOOLAH_ABI = [
    {
        name: "idToMarketParams",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }],
        outputs: [
            { name: "loanToken", type: "address" },
            { name: "collateralToken", type: "address" },
            { name: "oracle", type: "address" },
            { name: "irm", type: "address" },
            { name: "lltv", type: "uint256" },
        ],
    },
    {
        name: "providers",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }, { type: "address" }],
        outputs: [{ type: "address" }],
    },
];
const PROVIDER_ABI = [
    // present on every provider shape — the collateral token it serves
    {
        name: "TOKEN",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        name: "MOOLAH",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    // SmartProvider only — the probe that separates the two shapes
    {
        name: "dex",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        name: "dexInfo",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        name: "dexLP",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        name: "token",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256" }],
        outputs: [{ type: "address" }],
    },
];
const STABLESWAP_ABI = [
    {
        name: "token",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        name: "coins",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256" }],
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
    {
        name: "decimals",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
    },
];
function client(chainId) {
    const urls = RPCS[chainId];
    if (!urls)
        throw new Error(`No RPC configured for chain ${chainId}`);
    return createPublicClient({
        transport: fallback(urls.map((u) => http(u, { batch: true }))),
        batch: { multicall: true },
    });
}
/** `undefined` when the contract has no such function (empty revert). */
async function tryRead(fn) {
    try {
        return await fn();
    }
    catch {
        return undefined;
    }
}
async function erc20(c, address) {
    if (address.toLowerCase() === NATIVE_SENTINEL) {
        return { symbol: "NATIVE", decimals: 18 };
    }
    const [symbol, decimals] = await Promise.all([
        c.readContract({
            address: address,
            abi: ERC20_ABI,
            functionName: "symbol",
        }),
        c.readContract({
            address: address,
            abi: ERC20_ABI,
            functionName: "decimals",
        }),
    ]);
    return { symbol: symbol, decimals: Number(decimals) };
}
async function collectChain(chainId, moolah, marketIds, nativeProvider) {
    const c = client(chainId);
    // 1. market -> collateral token
    const params = await Promise.all(marketIds.map((id) => c.readContract({
        address: moolah,
        abi: MOOLAH_ABI,
        functionName: "idToMarketParams",
        args: [id],
    })));
    // 2. (market, collateral) -> provider
    const providers = await Promise.all(marketIds.map((id, i) => c.readContract({
        address: moolah,
        abi: MOOLAH_ABI,
        functionName: "providers",
        args: [id, params[i][1]],
    })));
    const marketsPerProvider = new Map();
    for (const p of providers) {
        const key = p.toLowerCase();
        if (key === zeroAddress)
            continue;
        marketsPerProvider.set(key, (marketsPerProvider.get(key) ?? 0) + 1);
    }
    const out = {};
    for (const provider of [...marketsPerProvider.keys()].sort()) {
        const token = await tryRead(() => c.readContract({
            address: provider,
            abi: PROVIDER_ABI,
            functionName: "TOKEN",
        }));
        if (!token) {
            throw new Error(`chain ${chainId}: provider ${provider} has no TOKEN() — unknown shape, ` +
                `inspect it before publishing (serving ${marketsPerProvider.get(provider)} markets)`);
        }
        const collateralToken = token.toLowerCase();
        const collateralMeta = await erc20(c, collateralToken);
        // THE probe. Only SmartProvider answers `dex()`.
        const dex = await tryRead(() => c.readContract({
            address: provider,
            abi: PROVIDER_ABI,
            functionName: "dex",
        }));
        if (!dex) {
            out[provider] = {
                kind: nativeProvider && nativeProvider.toLowerCase() === provider
                    ? "native"
                    : "erc20",
                collateralToken,
                collateralSymbol: collateralMeta.symbol,
                collateralDecimals: collateralMeta.decimals,
            };
            continue;
        }
        const [dexInfo, dexLp, t0, t1] = await Promise.all([
            c.readContract({
                address: provider,
                abi: PROVIDER_ABI,
                functionName: "dexInfo",
            }),
            c.readContract({
                address: provider,
                abi: PROVIDER_ABI,
                functionName: "dexLP",
            }),
            c.readContract({
                address: provider,
                abi: PROVIDER_ABI,
                functionName: "token",
                args: [0n],
            }),
            c.readContract({
                address: provider,
                abi: PROVIDER_ABI,
                functionName: "token",
                args: [1n],
            }),
        ]);
        // Invariant: the provider's LP handle IS the pool's LP token. If these ever
        // disagree the wiring has been re-pointed and every quote below is wrong.
        const poolLp = await c.readContract({
            address: dex,
            abi: STABLESWAP_ABI,
            functionName: "token",
        });
        if (poolLp.toLowerCase() !== dexLp.toLowerCase()) {
            throw new Error(`chain ${chainId}: provider ${provider} dexLP ${dexLp} != pool token ${poolLp}`);
        }
        // Invariant: coin order comes from the POOL, never from the collateral
        // symbol — "USDT & USDe-SmartLP" is coins [USDe, USDT] on Ethereum.
        for (const [i, expected] of [t0, t1].entries()) {
            const coin = await c.readContract({
                address: dex,
                abi: STABLESWAP_ABI,
                functionName: "coins",
                args: [BigInt(i)],
            });
            if (coin.toLowerCase() !== expected.toLowerCase()) {
                throw new Error(`chain ${chainId}: provider ${provider} token(${i}) ${expected} != dex.coins(${i}) ${coin}`);
            }
        }
        const coins = (await Promise.all([t0, t1].map(async (t) => {
            const address = t.toLowerCase();
            const meta = await erc20(c, address);
            return {
                address,
                symbol: meta.symbol,
                decimals: meta.decimals,
                isNative: address === NATIVE_SENTINEL,
            };
        })));
        out[provider] = {
            kind: "smart-lp",
            collateralToken,
            collateralSymbol: collateralMeta.symbol,
            collateralDecimals: collateralMeta.decimals,
            dex: dex.toLowerCase(),
            dexInfo: dexInfo.toLowerCase(),
            dexLp: dexLp.toLowerCase(),
            coins,
        };
    }
    const counts = [...marketsPerProvider.entries()]
        .sort()
        .map(([p, n]) => `${out[p].kind} ${p} (${n} markets, ${out[p].collateralSymbol})`);
    console.log(`chain ${chainId}: ${counts.length} providers`);
    for (const line of counts)
        console.log(`  ${line}`);
    return out;
}
async function main() {
    const markets = readJsonFile(MARKETS_FILE)?.[FORK] ?? {};
    const pools = readJsonFile(POOLS_FILE)?.[FORK] ?? {};
    const natives = readJsonFile(NATIVE_PROVIDERS_FILE) ?? {};
    const roster = {};
    for (const chainId of Object.keys(markets).sort()) {
        const ids = markets[chainId] ?? [];
        const moolah = pools[chainId];
        if (!moolah)
            throw new Error(`No Moolah address for chain ${chainId}`);
        if (!ids.length)
            continue;
        roster[chainId] = await collectChain(chainId, getAddress(moolah), ids, natives[chainId]?.nativeProvider);
    }
    const result = await writeTextIfChanged(OUT_FILE, JSON.stringify(roster, null, 2) + "\n");
    console.log(`${OUT_FILE}: ${result}`);
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
