/**
 * Label Aave V4 position managers in `config/aave-v4-peripherals.json`.
 *
 * The Aave GraphQL API returns `name: "Unknown"` for the three on-behalf PMs
 * (Giver / Taker / Config) — only the gateways are labeled. The composer
 * leverage flow resolves these by name (`findAaveV4PositionManager(...,
 * 'taker')`), so this pass classifies each Unknown PM on-chain (by the
 * function selectors in its bytecode) and rewrites its `name` to the canonical
 * "Aave Giver/Taker/Config Position Manager". Already-named PMs (gateways) and
 * PMs that don't classify are left untouched.
 *
 * Run after `update:dataset` (or any time the PM list changes):
 *   pnpm update:aave-v4-pm-names
 *
 * Per-chain RPC override: set `AAVE_V4_PM_RPC_<chainId>` (comma-separated URLs).
 */
import { createPublicClient, http } from "viem";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { aaveV4PmCanonicalName, classifyAaveV4Pm, } from "./fetch/aave/classifyV4PositionManagers.js";
const FILE = "./config/aave-v4-peripherals.json";
/** Conservative public-RPC fallbacks; extend as more chains carry V4 spokes. */
const DEFAULT_RPCS = {
    "1": [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/eth",
        "https://cloudflare-eth.com",
    ],
};
function rpcsForChain(chainId) {
    const env = process.env[`AAVE_V4_PM_RPC_${chainId}`];
    if (env)
        return env.split(",").map((s) => s.trim()).filter(Boolean);
    return DEFAULT_RPCS[chainId] ?? [];
}
/** First RPC that answers `eth_blockNumber` wins. */
async function makeClient(chainId) {
    for (const url of rpcsForChain(chainId)) {
        try {
            const client = createPublicClient({ transport: http(url) });
            await client.getBlockNumber();
            return client;
        }
        catch {
            /* try next */
        }
    }
    return null;
}
function isUnknown(name) {
    return !name || String(name).trim().toLowerCase() === "unknown";
}
async function main() {
    const data = readJsonFile(FILE);
    if (!data || typeof data !== "object") {
        throw new Error(`Could not read ${FILE}`);
    }
    let renamed = 0;
    let unresolved = 0;
    const skippedChains = [];
    for (const chainId of Object.keys(data)) {
        const perSpoke = data[chainId]?.perSpoke;
        if (!perSpoke)
            continue;
        // Collect the Unknown PM addresses for this chain first so we only spin up
        // an RPC client when there's actually work to do.
        const targets = [];
        for (const spoke of Object.keys(perSpoke)) {
            const pms = perSpoke[spoke]?.positionManagers ?? [];
            pms.forEach((pm, idx) => {
                if (pm?.address && isUnknown(pm.name)) {
                    targets.push({ spoke, idx, address: String(pm.address).toLowerCase() });
                }
            });
        }
        if (targets.length === 0)
            continue;
        const client = await makeClient(chainId);
        if (!client) {
            skippedChains.push(chainId);
            console.warn(`[aave-v4-pm-names] chain ${chainId}: no reachable RPC (set AAVE_V4_PM_RPC_${chainId}) — ${targets.length} PM(s) left Unknown`);
            continue;
        }
        // De-dup bytecode fetches by address (a PM can serve several spokes).
        const kindByAddr = new Map();
        for (const addr of new Set(targets.map((t) => t.address))) {
            try {
                const code = await client.getBytecode({ address: addr });
                kindByAddr.set(addr, classifyAaveV4Pm(code));
            }
            catch (e) {
                kindByAddr.set(addr, null);
                console.warn(`[aave-v4-pm-names] chain ${chainId}: getBytecode(${addr}) failed: ${e?.message ?? e}`);
            }
        }
        for (const t of targets) {
            const kind = kindByAddr.get(t.address) ?? null;
            if (!kind) {
                unresolved++;
                continue;
            }
            perSpoke[t.spoke].positionManagers[t.idx].name = aaveV4PmCanonicalName(kind);
            renamed++;
        }
    }
    const result = await writeTextIfChanged(FILE, JSON.stringify(data, null, 2) + "\n");
    console.log(`[aave-v4-pm-names] ${result}: renamed ${renamed} PM(s)` +
        (unresolved ? `, ${unresolved} unresolved (left Unknown)` : "") +
        (skippedChains.length ? `, skipped chains: ${skippedChains.join(", ")}` : ""));
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
