/**
 * Fetches `description()` from every Compound V3 oracle contract
 * across all chains and writes the result to
 * packages/margin-fetcher/scripts/compoundV3OracleDescriptions.json
 *
 * Run:
 *   tsx packages/margin-fetcher/scripts/fetchOracleDescriptions.ts
 */
import { compoundV3Oracles } from '@1delta/data-sdk';
import { fetchLenderMetaFromDirAndInitialize } from '@1delta/initializer-sdk';
import { multicallRetryUniversal } from '@1delta/providers';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const DescriptionAbi = [
    {
        inputs: [],
        name: 'description',
        outputs: [{ internalType: 'string', name: '', type: 'string' }],
        stateMutability: 'view',
        type: 'function',
    },
];
async function main() {
    // Initialize data-sdk with compound v3 oracle data from GitHub
    await fetchLenderMetaFromDirAndInitialize({
        compoundV3Oracles: true,
    });
    const oracles = compoundV3Oracles() ?? {};
    const result = {};
    for (const [lender, chainOracles] of Object.entries(oracles)) {
        for (const [chainId, assetOracles] of Object.entries(chainOracles)) {
            const entries = Object.entries(assetOracles);
            if (entries.length === 0)
                continue;
            const assets = entries.map(([asset]) => asset);
            const oracleAddresses = entries.map(([, oracle]) => oracle);
            // Build one call per oracle
            const calls = oracleAddresses.map((oracle) => ({
                address: oracle,
                name: 'description',
            }));
            console.log(`Fetching ${calls.length} descriptions for ${lender} on chain ${chainId}...`);
            const results = await multicallRetryUniversal({
                chain: chainId,
                calls,
                abi: DescriptionAbi,
                allowFailure: true,
                maxRetries: 3,
            });
            // Map results back
            if (!result[lender])
                result[lender] = {};
            if (!result[lender][chainId])
                result[lender][chainId] = {};
            results.forEach((res, i) => {
                const desc = typeof res === 'string' ? res : null;
                result[lender][chainId][assets[i]] = {
                    oracle: oracleAddresses[i],
                    description: desc ?? 'FAILED',
                };
                if (!desc) {
                    console.warn(`  [WARN] description() failed for oracle ${oracleAddresses[i]} (asset ${assets[i]})`);
                }
            });
        }
    }
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const outPath = join(__dirname, 'compoundV3OracleDescriptions.json');
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(`\nWritten to ${outPath}`);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
