/**
 * Aave V4 config discovery: Hub → Assets → Spokes.
 *
 * Walks every hub in the seed for each chain, enumerates the spokes each
 * hub references, and produces a per-chain map keyed by spoke address.
 *
 * The output has **no fork dimension** — when the same spoke address is
 * reachable from multiple hubs, the entries are merged. The first hub that
 * referenced the spoke wins for `baseHubAttribution`.
 */
import { sleep } from '../../utils.js';
import { AAVE_V4_HUB_ABI, AAVE_V4_SPOKE_ABI, V4FetchFunctions, } from './abiV4.js';
import { multicallRetryUniversal } from '@1delta/providers';
import { AAVE_V4_HUB_SEED } from './v4Hubs.js';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
/** Reject multicall failure sentinels, zero, and malformed addresses. */
function isValidSpokeAddress(addr) {
    if (typeof addr !== 'string')
        return false;
    const a = addr.toLowerCase();
    if (a === '0x' || a === ZERO_ADDR)
        return false;
    if (!a.startsWith('0x') || a.length !== 42)
        return false;
    return /^0x[0-9a-f]{40}$/.test(a);
}
function isValidOracle(oracle) {
    return (!!oracle && oracle !== '' && oracle !== '0x' && oracle !== ZERO_ADDR);
}
export async function fetchAaveV4Configs() {
    const spokesOutput = {};
    for (const chain of Object.keys(AAVE_V4_HUB_SEED)) {
        spokesOutput[chain] = {};
        const hubs = AAVE_V4_HUB_SEED[chain];
        for (const { hub: hubRaw, attribution } of hubs) {
            const hubAddress = hubRaw.toLowerCase();
            console.log(`[${attribution}/${chain}] Discovering from Hub ${hubAddress}`);
            // Step 1: Get asset count
            let assetCount;
            try {
                const [rawCount] = (await multicallRetryUniversal({
                    chain,
                    calls: [
                        {
                            address: hubAddress,
                            name: V4FetchFunctions.getAssetCount,
                            args: [],
                        },
                    ],
                    abi: AAVE_V4_HUB_ABI,
                    allowFailure: false,
                }));
                assetCount = Number(rawCount);
            }
            catch (e) {
                console.error(`  Error getting asset count: ${e?.message ?? e}`);
                continue;
            }
            console.log(`  Found ${assetCount} hub assets`);
            await sleep(250);
            if (assetCount === 0)
                continue;
            // Step 2: For each asset, get spoke count
            const spokeCalls = [];
            for (let assetId = 0; assetId < assetCount; assetId++) {
                spokeCalls.push({
                    address: hubAddress,
                    name: V4FetchFunctions.getSpokeCount,
                    args: [assetId],
                });
            }
            let spokeCounts;
            try {
                spokeCounts = (await multicallRetryUniversal({
                    chain,
                    calls: spokeCalls,
                    abi: AAVE_V4_HUB_ABI,
                    allowFailure: true,
                }));
            }
            catch (e) {
                console.error(`  Error getting spoke counts: ${e?.message ?? e}`);
                continue;
            }
            await sleep(250);
            // Step 3: For each asset, enumerate spoke addresses
            const spokeAddrCalls = [];
            for (let assetId = 0; assetId < assetCount; assetId++) {
                const count = Number(spokeCounts[assetId] ?? 0);
                for (let si = 0; si < count; si++) {
                    spokeAddrCalls.push({
                        address: hubAddress,
                        name: V4FetchFunctions.getSpokeAddress,
                        args: [assetId, si],
                    });
                }
            }
            if (spokeAddrCalls.length === 0) {
                console.log('  No spokes found');
                continue;
            }
            let spokeAddrResults;
            try {
                spokeAddrResults = (await multicallRetryUniversal({
                    chain,
                    calls: spokeAddrCalls,
                    abi: AAVE_V4_HUB_ABI,
                    allowFailure: true,
                }));
            }
            catch (e) {
                console.error(`  Error getting spoke addresses: ${e?.message ?? e}`);
                continue;
            }
            await sleep(250);
            // Deduplicate spoke addresses (drop multicall failure sentinels / invalid)
            const uniqueSpokes = new Set();
            for (const addr of spokeAddrResults) {
                if (isValidSpokeAddress(addr)) {
                    uniqueSpokes.add(addr.toLowerCase());
                }
            }
            console.log(`  Found ${uniqueSpokes.size} unique spokes`);
            // Step 4: For each spoke, get ORACLE() — only fetch for spokes we
            // haven't already seen the oracle for in this chain.
            const spokesNeedingOracle = [...uniqueSpokes].filter((s) => {
                const existing = spokesOutput[chain][s];
                return !existing || !isValidOracle(existing.oracle);
            });
            let oracleResults = [];
            if (spokesNeedingOracle.length > 0) {
                const oracleCalls = spokesNeedingOracle.map((spoke) => ({
                    address: spoke,
                    name: V4FetchFunctions.ORACLE,
                    args: [],
                }));
                try {
                    oracleResults = (await multicallRetryUniversal({
                        chain,
                        calls: oracleCalls,
                        abi: AAVE_V4_SPOKE_ABI,
                        allowFailure: true,
                    }));
                }
                catch (e) {
                    console.error(`  Error getting oracles: ${e?.message ?? e}`);
                }
                await sleep(250);
            }
            const oracleByAddr = {};
            for (let i = 0; i < spokesNeedingOracle.length; i++) {
                const raw = oracleResults[i];
                const oracle = (raw ?? '').toString().toLowerCase();
                oracleByAddr[spokesNeedingOracle[i]] = oracle;
            }
            // Merge into chain-level output, deduping by spoke address
            for (const spokeAddr of uniqueSpokes) {
                const existing = spokesOutput[chain][spokeAddr];
                const newOracle = oracleByAddr[spokeAddr];
                if (existing) {
                    // Already discovered from a previous hub — record this hub too
                    if (!existing.referencedByHubs.includes(hubAddress)) {
                        existing.referencedByHubs.push(hubAddress);
                    }
                    if (!isValidOracle(existing.oracle) && isValidOracle(newOracle)) {
                        existing.oracle = newOracle;
                    }
                    continue;
                }
                if (newOracle !== undefined && !isValidOracle(newOracle)) {
                    console.warn(`  [${attribution}/${chain}] Spoke ${spokeAddr}: ORACLE() returned empty/zero`);
                }
                spokesOutput[chain][spokeAddr] = {
                    spoke: spokeAddr,
                    oracle: newOracle ?? '',
                    label: `Spoke ${spokeAddr.slice(0, 6)}..${spokeAddr.slice(-4)}`,
                    baseHubAttribution: attribution,
                    referencedByHubs: [hubAddress],
                };
            }
        }
    }
    console.log('  Discovered aave-v4 spokes (flat-by-chain)');
    return { spokes: spokesOutput };
}
