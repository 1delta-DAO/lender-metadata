// ============================================================================
// Shared types for Morpho-style vaults across forks.
// Used for forks where we cannot query the official Morpho API
// (e.g. LISTA_DAO).
// ============================================================================

export type MorphoTypeVault = {
  vault: string;
  underlying: string;
  name?: string;
  /**
   * Vault interface version:
   *   - `v1` — MetaMorpho (withdraw-queue → Morpho Blue markets)
   *   - `v2` — Vaults V2 (adapter-based; no withdraw queue)
   * Drives the consumer's allocation walk (APR + liquidity). Detected
   * on-chain at discovery time (V2 vaults expose `adaptersLength()`).
   * Absent ⇒ consumers auto-detect (treat as v1 unless `adaptersLength()`
   * resolves).
   */
  version?: "v1" | "v2";
};

export type MorphoTypeVaultsByChain = Record<string, MorphoTypeVault[]>;

export type MorphoTypeVaultsByFork = Record<string, MorphoTypeVaultsByChain>;
