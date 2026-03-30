/**
 * Aave V4 oracle discovery.
 *
 * Pure function variant: takes spokes + reserves data, returns oracles + sources.
 */
import { sleep } from '../../utils.js';
import { AAVE_V4_ORACLE_ABI, V4FetchFunctions } from './abiV4.js';
import { multicallRetryUniversal } from '@1delta/providers';
export async function fetchAaveV4Oracles(spokesData, reservesData, detailsData) {
    const forks = Object.keys(spokesData);
    const oracleOutput = {};
    const sourcesOutput = {};
    for (const fork of forks) {
        oracleOutput[fork] = {};
        sourcesOutput[fork] = {};
        const chainsData = spokesData[fork];
        for (const chain of Object.keys(chainsData)) {
            const spokes = chainsData[chain];
            oracleOutput[fork][chain] = [];
            sourcesOutput[fork][chain] = [];
            console.log(`[${fork}/${chain}] Fetching oracle sources for ${spokes.length} spokes`);
            for (const spokeEntry of spokes) {
                const oracleAddr = spokeEntry.oracle;
                if (!oracleAddr ||
                    oracleAddr === '' ||
                    oracleAddr === '0x' ||
                    oracleAddr ===
                        '0x0000000000000000000000000000000000000000') {
                    console.warn(`  [${fork}/${chain}] Skipping spoke ${spokeEntry.spoke} (${spokeEntry.label}): oracle is "${oracleAddr}"`);
                    continue;
                }
                const reserveIds = reservesData[fork]?.[chain]?.[spokeEntry.spoke] ?? [];
                if (reserveIds.length === 0)
                    continue;
                const reserveDetails = detailsData[fork]?.[chain]?.[spokeEntry.spoke] ?? [];
                // Fetch oracle decimals + per-reserve sources
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
                let results;
                try {
                    results = (await multicallRetryUniversal({
                        chain,
                        calls,
                        abi: AAVE_V4_ORACLE_ABI,
                        allowFailure: true,
                    }));
                }
                catch (e) {
                    console.error(`  Error fetching oracle for spoke ${spokeEntry.spoke}: ${e?.message ?? e}`);
                    continue;
                }
                await sleep(250);
                const oracleDecimals = Number(results[0] ?? 8);
                for (let i = 0; i < reserveIds.length; i++) {
                    const rid = reserveIds[i];
                    const detail = reserveDetails.find((d) => d.reserveId === rid);
                    const underlying = detail?.underlying ?? '';
                    const source = (results[i + 1] ?? '')
                        .toString()
                        .toLowerCase();
                    oracleOutput[fork][chain].push({
                        underlying,
                        spoke: spokeEntry.spoke,
                        reserveId: rid,
                        oracle: oracleAddr,
                    });
                    sourcesOutput[fork][chain].push({
                        underlying,
                        spoke: spokeEntry.spoke,
                        reserveId: rid,
                        oracle: oracleAddr,
                        decimals: oracleDecimals,
                        source,
                    });
                }
            }
        }
    }
    console.log('  Written: aave-v4-oracles, aave-v4-oracle-sources');
    return { oracles: oracleOutput, sources: sourcesOutput };
}
