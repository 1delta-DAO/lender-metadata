import { toFunctionSelector } from "viem";

/**
 * Aave V4 position-manager classification.
 *
 * The Aave GraphQL API only labels the gateway PMs ("Aave Native Gateway",
 * "Aave Signature Gateway") — the three on-behalf PMs (Giver / Taker / Config)
 * all come back as "Unknown". The composer leverage flow needs to know which
 * PM is which (supply/repay → Giver, borrow/withdraw → Taker, collateral
 * config → Config), so we classify them on-chain by the function selectors
 * present in their deployed bytecode.
 *
 * Each PM kind exposes a disjoint set of entrypoints, so a single hit is
 * enough to classify:
 *   - Giver  → supplyOnBehalfOf / repayOnBehalfOf
 *   - Taker  → approveBorrow / approveWithdraw / borrowOnBehalfOf / withdrawOnBehalfOf
 *   - Config → setUsingAsCollateralOnBehalfOf / setGlobalPermission
 */
export type AaveV4PmKind = "giver" | "taker" | "config";

const SIGNATURES: Record<AaveV4PmKind, string[]> = {
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
export const AAVE_V4_PM_SELECTORS: Record<AaveV4PmKind, string[]> =
  Object.fromEntries(
    (Object.keys(SIGNATURES) as AaveV4PmKind[]).map((kind) => [
      kind,
      SIGNATURES[kind].map((sig) => toFunctionSelector(sig).slice(2).toLowerCase()),
    ]),
  ) as Record<AaveV4PmKind, string[]>;

/**
 * Canonical curated name for a classified PM. The substring (`Giver` / `Taker`
 * / `Config`) is what consumers match on (`findAaveV4PositionManager(...,
 * 'taker')`), so it MUST be preserved verbatim.
 */
export function aaveV4PmCanonicalName(kind: AaveV4PmKind): string {
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
export function classifyAaveV4Pm(bytecode: string | undefined): AaveV4PmKind | null {
  if (!bytecode || bytecode === "0x") return null;
  const code = bytecode.toLowerCase();
  for (const kind of ["giver", "taker", "config"] as AaveV4PmKind[]) {
    if (AAVE_V4_PM_SELECTORS[kind].some((sel) => code.includes(sel))) {
      return kind;
    }
  }
  return null;
}
