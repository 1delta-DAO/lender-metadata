import { createPublicClient, http } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { DOLOMITE_FALLBACK_RPCS } from "./constants.js";
import { DOLOMITE_ISOLATION_CONVERTERS } from "./isolation-converters.js";
/**
 * Wrapper / unwrapper roster per isolation-mode factory — see
 * `isolation-converters.ts` (vendored from the zap SDK). Every entry is
 * re-validated on-chain (`isTokenConverterTrusted`) on each run and an
 * untrusted or unknown converter is written as `null` — a consumer must then
 * refuse the loop rather than emit a zap that reverts `Invalid isolation mode
 * wrapper`. Re-snapshot when Dolomite lists a new isolation market.
 */
const CONVERTER_SEED = DOLOMITE_ISOLATION_CONVERTERS;
/** What Dolomite's routers and `GenericTraderProxyV2Lib` test `name()` against. */
const ISOLATION_PREFIX = "Dolomite Isolation:";
const FS_GLP_NAME = "Dolomite: Fee + Staked GLP";
const erc20Abi = [
    {
        type: "function",
        name: "name",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "symbol",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "decimals",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
    },
];
const factoryAbi = [
    {
        type: "function",
        name: "UNDERLYING_TOKEN",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "allowableDebtMarketIds",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256[]" }],
    },
    {
        type: "function",
        name: "allowableCollateralMarketIds",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256[]" }],
    },
    {
        type: "function",
        name: "isTokenConverterTrusted",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "executionFee",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
];
// multicall with a direct-RPC fallback for chains outside @1delta/providers.
async function read(chainId, calls, abi) {
    if (calls.length === 0)
        return [];
    try {
        return (await multicallRetryUniversal({
            chain: chainId,
            calls: calls.map((c) => ({ ...c, args: c.args ?? [] })),
            abi,
            allowFailure: true,
        }));
    }
    catch (e) {
        const rpc = DOLOMITE_FALLBACK_RPCS[chainId];
        if (!rpc)
            throw e;
        const client = createPublicClient({ transport: http(rpc) });
        return Promise.all(calls.map((c) => client
            .readContract({
            address: c.address,
            abi,
            functionName: c.name,
            args: (c.args ?? []),
        })
            .catch(() => null)));
    }
}
const ok = (v) => v !== null && v !== undefined && v !== "0x";
/**
 * Detect the isolation-mode markets on a chain (by the same `name()` rule the
 * protocol uses) and read each factory's underlying, allow-lists, execution
 * fee and the on-chain trust of the vendored wrapper/unwrapper pair.
 */
export async function fetchDolomiteIsolation(chainId, markets) {
    const entries = Object.entries(markets);
    const names = await read(chainId, entries.map(([, token]) => ({ address: token, name: "name" })), erc20Abi);
    const iso = entries.filter(([, token], i) => {
        const n = names[i];
        return (typeof n === "string" &&
            (n.startsWith(ISOLATION_PREFIX) || n === FS_GLP_NAME));
    });
    if (iso.length === 0)
        return {};
    const seed = CONVERTER_SEED[chainId] ?? {};
    const facCalls = iso.flatMap(([, f]) => {
        const c = seed[f.toLowerCase()];
        return [
            { address: f, name: "UNDERLYING_TOKEN" },
            { address: f, name: "allowableDebtMarketIds" },
            { address: f, name: "allowableCollateralMarketIds" },
            { address: f, name: "executionFee" },
            // Probe the seed's converters; the zero address stands in when there is
            // no seed so the call layout stays fixed (answers false).
            {
                address: f,
                name: "isTokenConverterTrusted",
                args: [c?.wrapper ?? "0x0000000000000000000000000000000000000000"],
            },
            {
                address: f,
                name: "isTokenConverterTrusted",
                args: [c?.unwrapper ?? "0x0000000000000000000000000000000000000000"],
            },
        ];
    });
    const fac = await read(chainId, facCalls, factoryAbi);
    const underlyings = iso.map((_, i) => fac[i * 6]);
    const undCalls = underlyings.flatMap((u) => ok(u)
        ? [
            { address: u, name: "symbol" },
            { address: u, name: "decimals" },
        ]
        : []);
    const und = await read(chainId, undCalls, erc20Abi);
    const out = {};
    let u = 0;
    iso.forEach(([marketId, factory], i) => {
        const base = i * 6;
        const underlying = fac[base];
        if (!ok(underlying)) {
            console.log(`Dolomite: chain ${chainId}: isolation market ${marketId} (${factory}) has no UNDERLYING_TOKEN — skipped`);
            return;
        }
        const symbol = und[u * 2];
        const decimals = und[u * 2 + 1];
        u++;
        const c = seed[factory.toLowerCase()];
        const wrapperTrusted = c ? fac[base + 4] === true : false;
        const unwrapperTrusted = c ? fac[base + 5] === true : false;
        if (c && !(wrapperTrusted && unwrapperTrusted)) {
            console.log(`Dolomite: chain ${chainId}: isolation market ${marketId} converters from the seed are NOT trusted on-chain (wrapper ${wrapperTrusted}, unwrapper ${unwrapperTrusted}) — written as null`);
        }
        const fee = fac[base + 3];
        out[marketId] = {
            factory: factory.toLowerCase(),
            underlying: String(underlying).toLowerCase(),
            underlyingSymbol: typeof symbol === "string" ? symbol : "",
            underlyingDecimals: ok(decimals) ? Number(decimals) : 18,
            allowableDebtMarketIds: (ok(fac[base + 1])
                ? fac[base + 1]
                : []).map(String),
            allowableCollateralMarketIds: (ok(fac[base + 2])
                ? fac[base + 2]
                : []).map(String),
            wrapper: wrapperTrusted ? c.wrapper.toLowerCase() : null,
            unwrapper: unwrapperTrusted ? c.unwrapper.toLowerCase() : null,
            wrapperInputMarketIds: c?.wrapperMarketIds ?? [],
            unwrapperOutputMarketIds: c?.unwrapperMarketIds ?? [],
            async: c?.isAsync ?? false,
            // `executionFee()` only exists on the async (GMX V2 / GLV) factories.
            executionFeeWei: ok(fee) ? String(fee) : null,
        };
    });
    return out;
}
