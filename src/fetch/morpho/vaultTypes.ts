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
   * Human curator/brand name (e.g. `Steakhouse Financial`). Filled by
   * `update-vault-curators.ts` — Morpho's global curator roster joined on the
   * vault's on-chain `curator()`/`owner()` address, with a conservative
   * name-derived fallback — because the chains in this file have no Morpho-API
   * coverage and their consumers cannot learn the curator any other way.
   */
  curatorName?: string;
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
