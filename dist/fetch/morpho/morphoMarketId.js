import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
/**
 * Morpho Blue `Id` / market id: keccak256(abi.encode(MarketParams)) where
 * MarketParams = (loanToken, collateralToken, oracle, irm, lltv).
 *
 * @see https://docs.morpho.org/
 */
export function computeMorphoMarketId(params) {
    const loanToken = params.loanToken.toLowerCase();
    const collateralToken = params.collateralToken.toLowerCase();
    const oracle = params.oracle.toLowerCase();
    const irm = params.irm.toLowerCase();
    const lltv = typeof params.lltv === "bigint" ? params.lltv : BigInt(params.lltv);
    const encoded = encodeAbiParameters(parseAbiParameters("address, address, address, address, uint256"), [loanToken, collateralToken, oracle, irm, lltv]);
    return keccak256(encoded);
}
/** Stable lookup key for matching JSON oracle rows to fetched market params. */
export function marketTripletKey(loanAsset, collateralAsset, oracle) {
    return `${loanAsset.toLowerCase()}:${collateralAsset.toLowerCase()}:${oracle.toLowerCase()}`;
}
/** yield-tracer `lender_key` / `markets.lender_key` for Morpho Blue isolated markets. */
export function morphoMarketIdToLenderKey(marketId) {
    const hex = marketId.replace(/^0x/i, "").toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) {
        throw new Error(`Invalid morpho marketId: ${marketId}`);
    }
    return `MORPHO_BLUE_${hex}`;
}
export function lenderKeyToMorphoMarketId(lenderKey) {
    if (!/^MORPHO_BLUE_[0-9A-F]{64}$/.test(lenderKey))
        return null;
    return `0x${lenderKey.slice("MORPHO_BLUE_".length).toLowerCase()}`;
}
