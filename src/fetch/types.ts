export type NameMap = { [id: string]: string };
export type StoredData = { names: NameMap; shortNames: NameMap };

export interface MrophoOracleInfo {
  oracle: string;
  loanAsset: string;
  collateralAsset: string;
  loanAssetDecimals: number;
  collateralAssetDecimals: number;
}

export type LabelsAndOracles = {
  labels: { names: NameMap; shortNames: NameMap };
  oracles: { [chainId: string]: MrophoOracleInfo[] };
};

export type Labels = { names: NameMap; shortNames: NameMap };
export type Oracles = { [chainId: string]: MrophoOracleInfo[] };
