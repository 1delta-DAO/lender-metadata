// ============================================================================
// Shared types for Morpho-style vaults across forks.
// Used for forks where we cannot query the official Morpho API
// (e.g. LISTA_DAO).
// ============================================================================

export type MorphoTypeVault = {
  vault: string;
  underlying: string;
  name?: string;
};

export type MorphoTypeVaultsByChain = Record<string, MorphoTypeVault[]>;

export type MorphoTypeVaultsByFork = Record<string, MorphoTypeVaultsByChain>;
