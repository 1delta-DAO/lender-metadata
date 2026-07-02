import { toFunctionSelector } from "viem";
const SIGNATURES = {
    giver: [
        "supplyOnBehalfOf(address,uint256,uint256,address)",
        "repayOnBehalfOf(address,uint256,uint256,address)",
    ],
    taker: [
        "approveBorrow(address,uint256,address,uint256)",
        "approveWithdraw(address,uint256,address,uint256)",
        "borrowOnBehalfOf(address,uint256,uint256,address)",
        "withdrawOnBehalfOf(address,uint256,uint256,address)",
    ],
    config: [
        "setUsingAsCollateralOnBehalfOf(address,uint256,bool,address)",
        "setGlobalPermission(address,address,bool)",
    ],
};
/** kind → array of 4-byte selectors (no `0x`) present in that PM's bytecode. */
export const AAVE_V4_PM_SELECTORS = Object.fromEntries(Object.keys(SIGNATURES).map((kind) => [
    kind,
    SIGNATURES[kind].map((sig) => toFunctionSelector(sig).slice(2).toLowerCase()),
]));
/**
 * Canonical curated name for a classified PM. The substring (`Giver` / `Taker`
 * / `Config`) is what consumers match on (`findAaveV4PositionManager(...,
 * 'taker')`), so it MUST be preserved verbatim.
 */
export function aaveV4PmCanonicalName(kind) {
    switch (kind) {
        case "giver":
            return "Aave Giver Position Manager";
        case "taker":
            return "Aave Taker Position Manager";
        case "config":
            return "Aave Config Position Manager";
    }
}
/**
 * Classify a PM from its deployed bytecode by selector presence. Returns the
 * kind, or `null` when no distinguishing selector is found (e.g. a gateway, a
 * proxy that hides the implementation selectors, or empty code).
 *
 * Checked in giver → taker → config order; the selector sets are disjoint so
 * order only matters for the degenerate case of a contract exposing more than
 * one family (not expected for Aave V4 PMs).
 */
export function classifyAaveV4Pm(bytecode) {
    if (!bytecode || bytecode === "0x")
        return null;
    const code = bytecode.toLowerCase();
    for (const kind of ["giver", "taker", "config"]) {
        if (AAVE_V4_PM_SELECTORS[kind].some((sel) => code.includes(sel))) {
            return kind;
        }
    }
    return null;
}
