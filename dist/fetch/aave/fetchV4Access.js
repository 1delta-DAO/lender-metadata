/**
 * Aave V4 spoke ACCESS detection — which user-facing operations a spoke
 * restricts to an allowlist, and how to test an address against it.
 *
 * WHY THIS EXISTS
 * ---------------
 * A V4 spoke can be a whitelabel instance that subclasses the stock
 * `SpokeInstance` and narrows one operation. Nothing in the reserve data says
 * so: every read (`getReserveConfig().borrowable`, the caps, the rates) reports
 * a perfectly ordinary borrowable market, and the restriction only appears when
 * the transaction reverts. That is the same failure shape as Brix's vault,
 * where `maxDeposit` returned `uint.max` on a token no ordinary wallet could
 * even receive — a fork found it and no view ever would.
 *
 * WHAT IS DETECTED
 * ----------------
 * `ETHERFI_DATA_PROVIDER()` — a public constant on `EtherFiSpokeInstance`,
 * which is ether.fi's whitelabel Aave V4 spoke. It reverts on a stock spoke, so
 * a non-zero answer positively identifies the variant. That contract's ONLY
 * override is `borrow`, gated on `EtherFiDataProvider.isEtherFiSafe(onBehalfOf)`
 * — verified three ways on the OP Mainnet deployment (spoke
 * `0xdffcC353…`, impl `0xA1f75D80…`, Sourcify `match`):
 *
 *   1. SOURCE   — the verified contract defines exactly one function, `borrow`.
 *   2. BYTECODE — the impl runtime contains the `isEtherFiSafe(address)`
 *                 selector `0xb7ca418b`; neither Ethereum spoke impl does.
 *   3. FORK     — as a plain EOA with USDC: supply, setUsingAsCollateral,
 *                 withdraw and setUserPositionManager all SUCCEED; `borrow`
 *                 reverts `OnlyEtherFiSafe(caller)` (`0xe883803e`).
 *
 * WHAT IS **NOT** RECORDED HERE
 * -----------------------------
 * A third-party `repay`/`supply` for someone else reverts `Unauthorized()`
 * (`0x82b42900`) on this spoke — but that is the STOCK V4
 * `onlyPositionManager(onBehalfOf)` rule, which holds on Aave's own spokes too
 * and is already modelled by the position-manager layer. Recording it as a
 * per-spoke restriction would misattribute a protocol-wide property to one
 * deployment. Only what this spoke does DIFFERENTLY belongs in this field.
 *
 * FAIL-CLOSED
 * -----------
 * A failed probe leaves `access` undefined, i.e. "unknown", not "open" — and
 * the merge in `aave-v4.ts` keeps any previously recorded gate rather than
 * letting an RPC flake silently unlock a market.
 */
import { sleep } from '../../utils.js';
import { multicallRetryUniversal } from '@1delta/providers';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export const AAVE_V4_ACCESS_PROBE_ABI = [
    {
        inputs: [],
        name: 'ETHERFI_DATA_PROVIDER',
        outputs: [{ name: '', type: 'address' }],
        stateMutability: 'view',
        type: 'function',
    },
];
function isValidAddr(a) {
    return (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO_ADDR);
}
export async function fetchAaveV4Access(spokes) {
    const out = {};
    for (const chain of Object.keys(spokes ?? {})) {
        const addrs = Object.keys(spokes[chain] ?? {});
        if (addrs.length === 0)
            continue;
        out[chain] = {};
        let results;
        try {
            results = (await multicallRetryUniversal({
                chain,
                calls: addrs.map((address) => ({
                    address,
                    name: 'ETHERFI_DATA_PROVIDER',
                    args: [],
                })),
                abi: AAVE_V4_ACCESS_PROBE_ABI,
                allowFailure: true,
            }));
        }
        catch (e) {
            console.error(`[${chain}] Aave V4 access probe failed: ${e?.message ?? e} — leaving access unknown`);
            continue;
        }
        await sleep(250);
        addrs.forEach((addr, i) => {
            const provider = results?.[i];
            if (!isValidAddr(provider))
                return; // stock spoke (call reverts) or probe failed
            out[chain][addr] = {
                restrictedOperations: ['borrow'],
                gate: {
                    contract: String(provider).toLowerCase(),
                    check: 'isEtherFiSafe(address)',
                    label: 'ether.fi Cash Safe',
                },
            };
            console.log(`  [${chain}] ${addr}: borrow restricted to ${'ether.fi Cash Safe'}s via ${provider}`);
        });
    }
    return out;
}
