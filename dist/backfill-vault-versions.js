// ============================================================================
// One-pass backfill of the `version` field on every vault in
// data/morpho-type-vaults.json, across all forks and chains, by probing
// `adaptersLength()` on-chain (V2 → exposes it, V1 → reverts).
//
// Only fills vaults that currently lack a `version` by default; pass --all to
// re-probe and refresh every vault. Chains whose RPC is unreachable are skipped
// (their vaults are left undetermined) and reported.
// ============================================================================
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { detectVaultVersions } from "./fetch/morpho/vaultVersion.js";
const VAULTS_FILE = "./data/morpho-type-vaults.json";
async function main() {
    const refreshAll = process.argv.includes("--all");
    const data = readJsonFile(VAULTS_FILE);
    // Collect (fork, chain) groups that have at least one vault needing a version.
    const groups = [];
    for (const [fork, byChain] of Object.entries(data)) {
        for (const [chainId, vaults] of Object.entries(byChain)) {
            const needs = refreshAll || vaults.some((v) => !v.version);
            if (needs && vaults.length > 0)
                groups.push({ fork, chainId });
        }
    }
    console.log(`Probing ${groups.length} fork/chain groups${refreshAll ? " (refresh all)" : ""}`);
    let set = 0;
    let changed = 0;
    const failures = [];
    await Promise.all(groups.map(async ({ fork, chainId }) => {
        const vaults = data[fork][chainId];
        const addrs = vaults.map((v) => v.vault.toLowerCase());
        const versions = await detectVaultVersions(chainId, addrs);
        if (versions.every((x) => x === null)) {
            failures.push(`${fork}:${chainId}`);
            console.warn(`  ${fork} chain ${chainId}: probe failed (unreachable)`);
            return;
        }
        let local = 0;
        for (let i = 0; i < vaults.length; i++) {
            const version = versions[i];
            if (!version)
                continue;
            if (!refreshAll && vaults[i].version)
                continue;
            if (vaults[i].version !== version) {
                if (vaults[i].version)
                    changed++;
                else
                    set++;
                vaults[i].version = version;
                local++;
            }
        }
        console.log(`  ${fork} chain ${chainId}: ${local} updated`);
    }));
    // Keep each chain's vaults sorted by address (matches the update jobs).
    for (const byChain of Object.values(data)) {
        for (const chainId of Object.keys(byChain)) {
            byChain[chainId].sort((a, b) => a.vault.localeCompare(b.vault));
        }
    }
    const writeResult = await writeTextIfChanged(VAULTS_FILE, JSON.stringify(data, null, 2) + "\n");
    console.log(`Set ${set} new versions, changed ${changed}; file ${writeResult}.`);
    if (failures.length > 0) {
        console.warn(`Could not probe ${failures.length} group(s) (unreachable RPC): ${failures.join(", ")}`);
    }
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
