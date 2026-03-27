import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

/**
 * Morpho Blue `Id` / market id: keccak256(abi.encode(MarketParams)) where
 * MarketParams = (loanToken, collateralToken, oracle, irm, lltv).
 *
 * @see https://docs.morpho.org/
 */
export function computeMorphoMarketId(params: {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint | string;
}): Hex {
  const loanToken = params.loanToken.toLowerCase() as Hex;
  const collateralToken = params.collateralToken.toLowerCase() as Hex;
  const oracle = params.oracle.toLowerCase() as Hex;
  const irm = params.irm.toLowerCase() as Hex;
  const lltv = typeof params.lltv === "bigint" ? params.lltv : BigInt(params.lltv);

  const encoded = encodeAbiParameters(
    parseAbiParameters("address, address, address, address, uint256"),
    [loanToken, collateralToken, oracle, irm, lltv]
  );
  return keccak256(encoded);
}

/** Stable lookup key for matching JSON oracle rows to fetched market params. */
export function marketTripletKey(
  loanAsset: string,
  collateralAsset: string,
  oracle: string
): string {
  return `${loanAsset.toLowerCase()}:${collateralAsset.toLowerCase()}:${oracle.toLowerCase()}`;
}

export function morphoMarketIdToLenderKey(marketId: string): string {
  const hex = marketId.replace(/^0x/i, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new Error(`Invalid morpho marketId: ${marketId}`);
  }
  return `MORPHO_BLUE_${hex}`;
}

export function lenderKeyToMorphoMarketId(lenderKey: string): string | null {
  if (!/^MORPHO_BLUE_[0-9A-F]{64}$/.test(lenderKey)) return null;
  return `0x${lenderKey.slice("MORPHO_BLUE_".length).toLowerCase()}`;
}
