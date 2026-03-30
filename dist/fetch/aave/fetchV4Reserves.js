/**
 * Aave V4 reserves discovery: Spoke → Reserve data
 *
 * Pure function variant: takes spokes data, returns reserves + details.
 */
import { sleep } from '../../utils.js';
import { AAVE_V4_SPOKE_ABI, V4FetchFunctions } from './abiV4.js';
import { multicallRetryUniversal } from '@1delta/providers';
export async function fetchAaveV4Reserves(spokesData) {
    const forks = Object.keys(spokesData);
    const reservesOutput = {};
    const detailsOutput = {};
    for (const fork of forks) {
        reservesOutput[fork] = {};
        detailsOutput[fork] = {};
        const chainsData = spokesData[fork];
        for (const chain of Object.keys(chainsData)) {
            const spokes = chainsData[chain];
            reservesOutput[fork][chain] = {};
            detailsOutput[fork][chain] = {};
            console.log(`[${fork}/${chain}] Fetching reserves for ${spokes.length} spokes`);
            // Step 1: Get reserve count for all spokes
            const countCalls = spokes.map((s) => ({
                address: s.spoke,
                name: V4FetchFunctions.getReserveCount,
                args: [],
            }));
            let countResults;
            try {
                countResults = (await multicallRetryUniversal({
                    chain,
                    calls: countCalls,
                    abi: AAVE_V4_SPOKE_ABI,
                    allowFailure: true,
                }));
            }
            catch (e) {
                console.error(`  Error getting reserve counts: ${e?.message ?? e}`);
                continue;
            }
            await sleep(250);
            // Step 2: For each spoke, fetch getReserve(i) and getReserveConfig(i)
            const reserveCalls = [];
            const callMeta = [];
            for (let si = 0; si < spokes.length; si++) {
                const spokeAddr = spokes[si].spoke;
                const count = Number(countResults[si] ?? 0);
                for (let ri = 0; ri < count; ri++) {
                    reserveCalls.push({
                        address: spokeAddr,
                        name: V4FetchFunctions.getReserve,
                        args: [ri],
                    });
                    callMeta.push({
                        spokeAddr,
                        reserveId: ri,
                        callType: 'reserve',
                    });
                    reserveCalls.push({
                        address: spokeAddr,
                        name: V4FetchFunctions.getReserveConfig,
                        args: [ri],
                    });
                    callMeta.push({
                        spokeAddr,
                        reserveId: ri,
                        callType: 'config',
                    });
                }
            }
            if (reserveCalls.length === 0) {
                console.log('  No reserves found');
                continue;
            }
            let reserveResults;
            try {
                reserveResults = (await multicallRetryUniversal({
                    chain,
                    calls: reserveCalls,
                    abi: AAVE_V4_SPOKE_ABI,
                    allowFailure: true,
                }));
            }
            catch (e) {
                console.error(`  Error fetching reserve data: ${e?.message ?? e}`);
                continue;
            }
            await sleep(250);
            // Parse results
            const spokeReserves = {};
            for (let i = 0; i < callMeta.length; i++) {
                const meta = callMeta[i];
                const result = reserveResults[i];
                if (!spokeReserves[meta.spokeAddr]) {
                    spokeReserves[meta.spokeAddr] = [];
                }
                if (meta.callType === 'reserve') {
                    let entry = spokeReserves[meta.spokeAddr].find((r) => r.reserveId === meta.reserveId);
                    if (!entry) {
                        entry = {
                            reserveId: meta.reserveId,
                            underlying: '',
                            hub: '',
                            assetId: 0,
                            decimals: 18,
                            collateralRisk: 0,
                            dynamicConfigKey: 0,
                            borrowable: false,
                            paused: false,
                            frozen: false,
                        };
                        spokeReserves[meta.spokeAddr].push(entry);
                    }
                    entry.underlying = (result?.underlying ?? '').toLowerCase();
                    entry.hub = (result?.hub ?? '').toLowerCase();
                    entry.assetId = Number(result?.assetId ?? 0);
                    entry.decimals = Number(result?.decimals ?? 18);
                    entry.collateralRisk = Number(result?.collateralRisk ?? 0);
                    entry.dynamicConfigKey = Number(result?.dynamicConfigKey ?? 0);
                }
                else if (meta.callType === 'config') {
                    let entry = spokeReserves[meta.spokeAddr].find((r) => r.reserveId === meta.reserveId);
                    if (entry) {
                        entry.borrowable = result?.borrowable ?? false;
                        entry.paused = result?.paused ?? false;
                        entry.frozen = result?.frozen ?? false;
                    }
                }
            }
            // Build output
            for (const [spokeAddr, details] of Object.entries(spokeReserves)) {
                reservesOutput[fork][chain][spokeAddr] =
                    details.map((d) => d.reserveId);
                detailsOutput[fork][chain][spokeAddr] = details;
            }
            const totalReserves = Object.values(reservesOutput[fork][chain]).reduce((sum, arr) => sum + arr.length, 0);
            console.log(`  Found ${totalReserves} total reserves across ${Object.keys(reservesOutput[fork][chain]).length} spokes`);
        }
    }
    console.log('  Written: aave-v4-reserves, aave-v4-reserve-details');
    return { reserves: reservesOutput, details: detailsOutput };
}
