export type NameMap = { [id: string]: string };
export type StoredData = { names: NameMap; shortNames: NameMap };

export interface MrophoOracleInfo {
  oracle: string;
  loanAsset: string;
  collateralAsset: string;
  loanAssetDecimals: number;
  collateralAssetDecimals: number;
}

export type ReturnData = {
  names: NameMap;
  shortNames: NameMap;
  oracles: { [chainId: string]: MrophoOracleInfo[] };
};
