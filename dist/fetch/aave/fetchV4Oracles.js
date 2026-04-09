/**
 * Aave V4 oracle discovery.
 *
 * Operates on the flat-by-chain spoke map and per-spoke reserve details
 * produced upstream. Output has no fork dimension; entries are dedup'd by
 * (spoke, reserveId).
 */
import { sleep } from '../../utils.js';
import { AAVE_V4_ORACLE_ABI, V4FetchFunctions } from './abiV4.js';
import { multicallRetryUniversal } from '@1delta/providers';
/**
 * multicallRetryUniversal maps failed calls to the string "0x". Number("0x")
 * is NaN — normalize to a safe default.
 */
function normalizeOracleDecimals(raw) {
    if (raw === '0x' || raw === undefined || raw === null)
        return 8;
    if (typeof raw === 'bigint')
        return Number(raw);
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 255)
        return n;
    return 8;
}
function normalizeSourceAddress(raw) {
    if (raw === '0x' || raw === undefined || raw === null)
        return '';
    const s = String(raw).toLowerCase();
    if (s === '0x' || s === '0x0000000000000000000000000000000000000000')
        return '';
    return s;
}
export async function fetchAaveV4Oracles(spokesData, reservesData) {
    const oracleOutput = {};
    const sourcesOutput = {};
    for (const chain of Object.keys(spokesData)) {
        oracleOutput[chain] = [];
        sourcesOutput[chain] = [];
        const spokes = Object.values(spokesData[chain]);
        console.log(`[${chain}] Fetching oracle sources for ${spokes.length} spokes`);
        for (const spokeEntry of spokes) {
            const oracleAddr = spokeEntry.oracle;
            const hasOracle = !!oracleAddr &&
                oracleAddr !== '' &&
                oracleAddr !== '0x' &&
                oracleAddr !== '0x0000000000000000000000000000000000000000';
            if (!hasOracle) {
                console.warn(`  [${chain}] Spoke ${spokeEntry.spoke} (${spokeEntry.label}): oracle is "${oracleAddr}"`);
            }
            const reserveDetails = reservesData[chain]?.[spokeEntry.spoke] ?? [];
            const reserveIds = reserveDetails.map((r) => r.reserveId);
            if (reserveIds.length === 0)
                continue;
            let oracleDecimals = 0;
            let sourceResults = [];
            if (hasOracle) {
                const calls = [
                    {
                        address: oracleAddr,
                        name: V4FetchFunctions.decimals,
                        args: [],
                    },
                    ...reserveIds.map((rid) => ({
                        address: oracleAddr,
                        name: V4FetchFunctions.getReserveSource,
                        args: [rid],
                    })),
                ];
                try {
                    const results = (await multicallRetryUniversal({
                        chain,
                        calls,
                        abi: AAVE_V4_ORACLE_ABI,
                        allowFailure: true,
                    }));
                    oracleDecimals = normalizeOracleDecimals(results[0]);
                    sourceResults = results.slice(1);
                    // Retry only multicall failure sentinels
                    const failedSourceIdx = [];
                    for (let si = 0; si < sourceResults.length; si++) {
                        if (sourceResults[si] === '0x')
                            failedSourceIdx.push(si);
                    }
                    if (failedSourceIdx.length > 0) {
                        const retryCalls = failedSourceIdx.map((si) => ({
                            address: oracleAddr,
                            name: V4FetchFunctions.getReserveSource,
                            args: [reserveIds[si]],
                        }));
                        try {
                            const retryResults = (await multicallRetryUniversal({
                                chain,
                                calls: retryCalls,
                                abi: AAVE_V4_ORACLE_ABI,
                                allowFailure: true,
                            }));
                            for (let j = 0; j < failedSourceIdx.length; j++) {
                                sourceResults[failedSourceIdx[j]] = retryResults[j];
                            }
                        }
                        catch (retryErr) {
                            console.error(`  Retry getReserveSource for spoke ${spokeEntry.spoke}: ${retryErr?.message ?? retryErr}`);
                        }
                        await sleep(250);
                    }
                }
                catch (e) {
                    console.error(`  Error fetching oracle for spoke ${spokeEntry.spoke}: ${e?.message ?? e}`);
                }
                await sleep(250);
            }
            for (let i = 0; i < reserveIds.length; i++) {
                const rid = reserveIds[i];
                const detail = reserveDetails.find((d) => d.reserveId === rid);
                const underlying = detail?.underlying ?? '';
                const source = hasOracle
                    ? normalizeSourceAddress(sourceResults[i])
                    : '';
                oracleOutput[chain].push({
                    underlying,
                    spoke: spokeEntry.spoke,
                    reserveId: rid,
                    oracle: hasOracle ? oracleAddr : '0x',
                });
                sourcesOutput[chain].push({
                    underlying,
                    spoke: spokeEntry.spoke,
                    reserveId: rid,
                    oracle: hasOracle ? oracleAddr : '0x',
                    decimals: oracleDecimals,
                    source,
                });
            }
        }
    }
    return { oracles: oracleOutput, sources: sourcesOutput };
}
