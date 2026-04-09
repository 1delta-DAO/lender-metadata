// On-disk shapes for Silo v2 — match `SiloHalfStatic` / `SiloMarketEntry` /
// `SiloPeripheralsType` in `@1delta/data-sdk` (packages/data-sdk/src/lending.ts).

export type SiloHalfStatic = {
  silo: string;
  token: string;
  decimals: number;
  symbol?: string;
  protectedShareToken: string;
  collateralShareToken: string;
  debtShareToken: string;
  solvencyOracle: string;
  maxLtvOracle: string;
  interestRateModel: string;
  maxLtv: string;
  lt: string;
  liquidationTargetLtv: string;
  liquidationFee: string;
  flashloanFee: string;
  daoFee: string;
  deployerFee: string;
  hookReceiver?: string;
  callBeforeQuote?: boolean;
};

export type SiloMarketEntry = {
  siloConfig: string;
  name?: string;
  silo0: SiloHalfStatic;
  silo1: SiloHalfStatic;
};

export type SiloMarketsType = { [chainId: string]: SiloMarketEntry[] };

export type SiloPeripheralsEntry = {
  lens: string;
  factory: string;
  router?: string;
  incentivesController?: string | null;
};

export type SiloPeripheralsType = {
  [chainId: string]: SiloPeripheralsEntry;
};
