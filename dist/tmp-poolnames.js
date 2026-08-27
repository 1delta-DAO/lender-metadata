import { readFileSync } from "node:fs";
import { getEvmClient } from "@1delta/providers";
import { getAddress } from "viem";
const f = (n, o, ins = []) => [{ inputs: ins, name: n, outputs: [o], stateMutability: "view", type: "function" }];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function retry(fn, n = 5) { for (let i = 0; i < n; i++) {
    try {
        return await fn();
    }
    catch (e) {
        if (String(e.shortMessage ?? e.message).includes("reverted"))
            return null;
        await sleep(400 * (i + 1));
    }
} return null; }
const POOL_META = { type: "tuple", components: [
        { name: "name", type: "string" }, { name: "creator", type: "address" }, { name: "comptroller", type: "address" },
        { name: "blockPosted", type: "uint256" }, { name: "timestampPosted", type: "uint256" }
    ] };
async function main() {
    const pools = JSON.parse(readFileSync("./config/compound-v2-pools.json", "utf8"));
    for (const chain of ["56", "1"]) {
        // find the PoolRegistry from any isolated-pool comptroller on this chain
        const keys = Object.keys(pools).filter(k => k.startsWith("VENUS_") && pools[k][chain]);
        if (!keys.length)
            continue;
        const c = getEvmClient(chain);
        let registry = null;
        for (const k of keys) {
            registry = await retry(() => c.readContract({ address: getAddress(pools[k][chain]), abi: f("poolRegistry", { type: "address" }), functionName: "poolRegistry" }), 3);
            if (registry)
                break;
        }
        console.log(`\nchain ${chain}: PoolRegistry ${registry ?? "not exposed"}`);
        if (!registry)
            continue;
        const all = await retry(() => c.readContract({ address: getAddress(registry), abi: f("getAllPools", { type: "tuple[]", components: POOL_META.components }), functionName: "getAllPools" }));
        if (!all) {
            console.log("  getAllPools failed");
            continue;
        }
        const byComptroller = new Map();
        for (const p of all)
            byComptroller.set(String(p.comptroller).toLowerCase(), p.name);
        for (const k of keys) {
            const addr = String(pools[k][chain]).toLowerCase();
            console.log(`  ${k.padEnd(16)} ${addr}  official pool name: ${byComptroller.get(addr) ?? "(not in registry)"}`);
        }
    }
}
main();
