import { zeroAddress } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import { lendingResolverAbi, vaultResolverAbi, fTokenAbi } from "./abi.js";
function isOk(x) {
    return x !== undefined && x !== null && x !== "0x";
}
export async function getAllVaultAddresses(chainId, resolvers) {
    const [list] = (await multicallRetryUniversal({
        chain: chainId,
        calls: [
            {
                address: resolvers.vaultResolver,
                name: "getAllVaultsAddresses",
                args: [],
            },
        ],
        abi: vaultResolverAbi,
        allowFailure: false,
    }));
    return list ?? [];
}
export async function getAllFTokenAddresses(chainId, resolvers) {
    const [list] = (await multicallRetryUniversal({
        chain: chainId,
        calls: [
            {
                address: resolvers.lendingResolver,
                name: "getAllFTokens",
                args: [],
            },
        ],
        abi: lendingResolverAbi,
        allowFailure: false,
    }));
    return list ?? [];
}
export async function getFTokenMetas(chainId, fTokens) {
    if (fTokens.length === 0)
        return {};
    const calls = fTokens.flatMap((ft) => [
        { address: ft, name: "asset", args: [] },
        { address: ft, name: "symbol", args: [] },
        { address: ft, name: "isNativeUnderlying", args: [] },
    ]);
    const results = (await multicallRetryUniversal({
        chain: chainId,
        calls,
        abi: fTokenAbi,
        allowFailure: true,
    }));
    const out = {};
    for (let i = 0; i < fTokens.length; i++) {
        const asset = results[i * 3];
        const symbol = results[i * 3 + 1];
        const isNative = results[i * 3 + 2];
        if (!isOk(asset) || !isOk(symbol))
            continue;
        out[fTokens[i].toLowerCase()] = {
            underlying: asset.toLowerCase(),
            symbol: symbol,
            isNativeUnderlying: Boolean(isNative),
        };
    }
    return out;
}
/** Builds a map: underlying (lowercased) → fToken address (lowercased). */
export function buildFTokensByUnderlying(fTokenMetas) {
    const out = {};
    for (const [fToken, meta] of Object.entries(fTokenMetas)) {
        out[meta.underlying] = fToken;
    }
    return out;
}
function buildSide(token0, token1, dexOrLiquidity, fTokensByUnderlying) {
    const isSmart = token1 !== zeroAddress;
    const underlyings = isSmart
        ? [token0.toLowerCase(), token1.toLowerCase()]
        : [token0.toLowerCase()];
    return {
        assets: underlyings.map((underlying) => ({
            underlying,
            fToken: fTokensByUnderlying[underlying] ?? null,
        })),
        dex: isSmart ? dexOrLiquidity.toLowerCase() : null,
        smartLending: null,
    };
}
export async function getVaultMetas(chainId, vaults, fTokensByUnderlying, resolvers) {
    if (vaults.length === 0)
        return {};
    const calls = vaults.map((vault) => ({
        address: resolvers.vaultResolver,
        name: "getVaultEntireData",
        args: [vault],
    }));
    const results = (await multicallRetryUniversal({
        chain: chainId,
        calls,
        abi: vaultResolverAbi,
        allowFailure: true,
    }));
    const out = {};
    for (let i = 0; i < vaults.length; i++) {
        const r = results[i];
        if (!r || r === "0x" || !r.constantVariables)
            continue;
        const c = r.constantVariables;
        const supplyToken0 = c.supplyToken.token0;
        const supplyToken1 = c.supplyToken.token1;
        const borrowToken0 = c.borrowToken.token0;
        const borrowToken1 = c.borrowToken.token1;
        const supplyEntryPoint = c.supply;
        const borrowEntryPoint = c.borrow;
        out[vaults[i].toLowerCase()] = {
            vaultId: Number(c.vaultId),
            type: Number(c.vaultType),
            supply: buildSide(supplyToken0, supplyToken1, supplyEntryPoint, fTokensByUnderlying),
            borrow: buildSide(borrowToken0, borrowToken1, borrowEntryPoint, fTokensByUnderlying),
        };
    }
    return out;
}
