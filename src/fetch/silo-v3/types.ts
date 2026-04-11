// On-disk shapes for Silo v3. Closely mirrors the v2 shape in
// `../silo-v2/types.ts` so downstream consumers can share most of the
// parsing logic, with a few v3-only fields (e.g. `keeperFee`) added.

export type SiloV3HalfStatic = {
  silo: string;
  token: string;
  decimals: number;
  symbol?: string;
  index: number; // 0 | 1
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
  keeperFee?: string;
};

export type SiloV3MarketEntry = {
  siloConfig: string;
  name?: string;
  hookReceiver?: string;
  silo0: SiloV3HalfStatic;
  silo1: SiloV3HalfStatic;
};

export type SiloV3MarketsType = { [chainId: string]: SiloV3MarketEntry[] };

export type SiloV3PeripheralsEntry = {
  factory?: string;
  lens?: string;
  router?: string;
  leverageRouter?: string;
  siloDeployer?: string;
  incentivesControllerFactory?: string;
  tower?: string;
  dynamicKinkModelFactory?: string;
  interestRateModelV2Factory?: string;
  vaultsFactory?: string;
  vaultDeployer?: string;
  publicAllocator?: string;
  idleVaultsFactory?: string;
  incentivesControllerCLFactory?: string;
};

export type SiloV3PeripheralsType = {
  [chainId: string]: SiloV3PeripheralsEntry;
};
