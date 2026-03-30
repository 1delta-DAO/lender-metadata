/**
 * ABIs for Aave V4 metadata fetching.
 *
 * Hub: discover assets and spokes
 * Spoke: discover reserves and their config
 * Oracle: get price feed sources
 */

export const AAVE_V4_HUB_ABI = [
  {
    inputs: [],
    name: 'getAssetCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'assetId', type: 'uint256' }],
    name: 'getAsset',
    outputs: [
      {
        components: [
          { name: 'liquidity', type: 'uint120' },
          { name: 'realizedFees', type: 'uint120' },
          { name: 'decimals', type: 'uint8' },
          { name: 'addedShares', type: 'uint120' },
          { name: 'swept', type: 'uint120' },
          { name: 'premiumOffsetRay', type: 'int200' },
          { name: 'drawnShares', type: 'uint120' },
          { name: 'premiumShares', type: 'uint120' },
          { name: 'liquidityFee', type: 'uint16' },
          { name: 'drawnIndex', type: 'uint120' },
          { name: 'drawnRate', type: 'uint96' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'underlying', type: 'address' },
          { name: 'irStrategy', type: 'address' },
          { name: 'reinvestmentController', type: 'address' },
          { name: 'feeReceiver', type: 'address' },
          { name: 'deficitRay', type: 'uint200' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'assetId', type: 'uint256' }],
    name: 'getAssetUnderlyingAndDecimals',
    outputs: [
      { name: '', type: 'address' },
      { name: '', type: 'uint8' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'underlying', type: 'address' }],
    name: 'getAssetId',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'underlying', type: 'address' }],
    name: 'isUnderlyingListed',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'assetId', type: 'uint256' }],
    name: 'getSpokeCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'assetId', type: 'uint256' },
      { name: 'index', type: 'uint256' },
    ],
    name: 'getSpokeAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'assetId', type: 'uint256' },
      { name: 'spoke', type: 'address' },
    ],
    name: 'isSpokeListed',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'assetId', type: 'uint256' },
      { name: 'spoke', type: 'address' },
    ],
    name: 'getSpokeConfig',
    outputs: [
      {
        components: [
          { name: 'addCap', type: 'uint40' },
          { name: 'drawCap', type: 'uint40' },
          { name: 'riskPremiumThreshold', type: 'uint24' },
          { name: 'active', type: 'bool' },
          { name: 'halted', type: 'bool' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const AAVE_V4_SPOKE_ABI = [
  {
    inputs: [],
    name: 'getReserveCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'reserveId', type: 'uint256' }],
    name: 'getReserve',
    outputs: [
      {
        components: [
          { name: 'underlying', type: 'address' },
          { name: 'hub', type: 'address' },
          { name: 'assetId', type: 'uint16' },
          { name: 'decimals', type: 'uint8' },
          { name: 'collateralRisk', type: 'uint24' },
          { name: 'flags', type: 'uint8' },
          { name: 'dynamicConfigKey', type: 'uint32' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'reserveId', type: 'uint256' }],
    name: 'getReserveConfig',
    outputs: [
      {
        components: [
          { name: 'collateralRisk', type: 'uint24' },
          { name: 'paused', type: 'bool' },
          { name: 'frozen', type: 'bool' },
          { name: 'borrowable', type: 'bool' },
          { name: 'receiveSharesEnabled', type: 'bool' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'reserveId', type: 'uint256' },
      { name: 'dynamicConfigKey', type: 'uint32' },
    ],
    name: 'getDynamicReserveConfig',
    outputs: [
      {
        components: [
          { name: 'collateralFactor', type: 'uint16' },
          { name: 'maxLiquidationBonus', type: 'uint32' },
          { name: 'liquidationFee', type: 'uint16' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ORACLE',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getLiquidationConfig',
    outputs: [
      {
        components: [
          { name: 'targetHealthFactor', type: 'uint128' },
          { name: 'healthFactorForMaxBonus', type: 'uint64' },
          { name: 'liquidationBonusFactor', type: 'uint16' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const AAVE_V4_ORACLE_ABI = [
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'reserveId', type: 'uint256' }],
    name: 'getReserveSource',
    outputs: [{ name: 'source', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'reserveIds', type: 'uint256[]' }],
    name: 'getReservesPrices',
    outputs: [{ name: 'prices', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export enum V4FetchFunctions {
  // Hub
  getAssetCount = 'getAssetCount',
  getAsset = 'getAsset',
  getAssetUnderlyingAndDecimals = 'getAssetUnderlyingAndDecimals',
  getAssetId = 'getAssetId',
  getSpokeCount = 'getSpokeCount',
  getSpokeAddress = 'getSpokeAddress',
  getSpokeConfig = 'getSpokeConfig',
  // Spoke
  getReserveCount = 'getReserveCount',
  getReserve = 'getReserve',
  getReserveConfig = 'getReserveConfig',
  getDynamicReserveConfig = 'getDynamicReserveConfig',
  ORACLE = 'ORACLE',
  getLiquidationConfig = 'getLiquidationConfig',
  // Oracle
  decimals = 'decimals',
  getReserveSource = 'getReserveSource',
}
