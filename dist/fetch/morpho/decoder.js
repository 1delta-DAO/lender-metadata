const FIELD_SIZES = {
    addr: 20,
    u128: 16,
    u256: 32,
};
const MORPHO_RECORD_SIZE = 4 * FIELD_SIZES.addr + // loanToken, collateralToken, oracle, irm
    1 * FIELD_SIZES.u128 + // lltv
    2 * FIELD_SIZES.u256 + // price, rateAtTarget
    5 * FIELD_SIZES.u128 + // totals (4) + lastUpdate
    1 * FIELD_SIZES.u128; // fee
// = 256 bytes
const MOOLAH_RECORD_SIZE = 4 * FIELD_SIZES.addr + // loanToken, collateralToken, oracle, irm
    1 * FIELD_SIZES.u128 + // lltv
    3 * FIELD_SIZES.u256 + // loanTokenPrice, collateralTokenPrice, rateAtTarget
    5 * FIELD_SIZES.u128 + // totals (4) + lastUpdate
    1 * FIELD_SIZES.u128; // fee
// = 288 bytes
/**
 * Decode packed markets bytes into typed objects.
 * Auto-detects format based on data length and decodes accordingly.
 * Integers are parsed as big-endian BigInt. Addresses are 0x-prefixed lowercase hex.
 */
export function decodeMarkets(input) {
    const bytes = normalizeToBytes(input);
    // Auto-detect format based on data length
    if (bytes.length % MORPHO_RECORD_SIZE === 0) {
        return decodeMorphoMarkets(bytes);
    }
    else if (bytes.length % MOOLAH_RECORD_SIZE === 0) {
        return decodeMoolahMarkets(bytes);
    }
    else {
        throw new Error(`Invalid data length ${bytes.length}; not a multiple of ${MORPHO_RECORD_SIZE} (morpho) or ${MOOLAH_RECORD_SIZE} (moolah) bytes per record`);
    }
}
/**
 * Decode morpho markets
 */
export function decodeMorphoMarkets(bytes) {
    if (bytes.length % MORPHO_RECORD_SIZE !== 0) {
        throw new Error(`Invalid data length ${bytes.length}; not a multiple of ${MORPHO_RECORD_SIZE} bytes per record`);
    }
    const markets = [];
    for (let i = 0; i < bytes.length; i += MORPHO_RECORD_SIZE) {
        let o = i;
        const loanToken = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const collateralToken = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const oracle = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const irm = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const lltv = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const price = readUintBE(bytes, o, FIELD_SIZES.u256);
        o += FIELD_SIZES.u256;
        const rateAtTarget = readUintBE(bytes, o, FIELD_SIZES.u256);
        o += FIELD_SIZES.u256;
        const totalSupplyAssets = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const totalSupplyShares = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const totalBorrowAssets = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const totalBorrowShares = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const lastUpdate = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const fee = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        markets.push({
            loanToken,
            collateralToken,
            oracle,
            irm,
            lltv,
            price,
            rateAtTarget,
            totalSupplyAssets,
            totalSupplyShares,
            totalBorrowAssets,
            totalBorrowShares,
            lastUpdate,
            fee,
        });
    }
    return markets;
}
/**
 * Decode moolah markets (separate loan and collateral token prices)
 */
export function decodeMoolahMarkets(bytes) {
    if (bytes.length % MOOLAH_RECORD_SIZE !== 0) {
        throw new Error(`Invalid data length ${bytes.length}; not a multiple of ${MOOLAH_RECORD_SIZE} bytes per record`);
    }
    const markets = [];
    for (let i = 0; i < bytes.length; i += MOOLAH_RECORD_SIZE) {
        let o = i;
        const loanToken = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const collateralToken = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const oracle = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const irm = readAddress(bytes, o, FIELD_SIZES.addr);
        o += FIELD_SIZES.addr;
        const lltv = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const loanTokenPrice = readUintBE(bytes, o, FIELD_SIZES.u256);
        o += FIELD_SIZES.u256;
        const collateralTokenPrice = readUintBE(bytes, o, FIELD_SIZES.u256);
        o += FIELD_SIZES.u256;
        const rateAtTarget = readUintBE(bytes, o, FIELD_SIZES.u256);
        o += FIELD_SIZES.u256;
        const totalSupplyAssets = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const totalSupplyShares = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const totalBorrowAssets = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const totalBorrowShares = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const lastUpdate = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        const fee = readUintBE(bytes, o, FIELD_SIZES.u128);
        o += FIELD_SIZES.u128;
        // follows morpho calcs: collateral price / loan price, scaled by 1e36
        // assuming moolah follows same decimal normalization as morpho blue
        const calculatedPrice = collateralTokenPrice && loanTokenPrice ? (collateralTokenPrice * 10n ** 36n) / loanTokenPrice : 0n;
        markets.push({
            loanToken,
            collateralToken,
            oracle,
            irm,
            lltv,
            price: calculatedPrice,
            loanTokenPrice,
            collateralTokenPrice,
            rateAtTarget,
            totalSupplyAssets,
            totalSupplyShares,
            totalBorrowAssets,
            totalBorrowShares,
            lastUpdate,
            fee,
        });
    }
    return markets;
}
// ---------- helpers ----------
function normalizeToBytes(input) {
    if (typeof input !== "string") {
        return input;
    }
    let hex = input.startsWith("0x") ? input.slice(2) : input;
    if (hex.length % 2 !== 0)
        throw new Error("Hex string must have even length");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}
function readAddress(bytes, offset, len) {
    // Addresses are the raw 20 bytes, render as 0x + 40 hex chars (lowercase).
    const hex = toHex(bytes.subarray(offset, offset + len));
    return "0x" + hex;
}
function readUintBE(bytes, offset, len) {
    // Big-endian: (((b0 * 256) + b1) * 256 + ...) pattern.
    let v = 0n;
    const end = offset + len;
    for (let i = offset; i < end; i++) {
        v = (v << 8n) | BigInt(bytes[i]);
    }
    return v;
}
function toHex(arr) {
    let s = "";
    for (let i = 0; i < arr.length; i++) {
        const h = arr[i].toString(16).padStart(2, "0");
        s += h;
    }
    return s;
}
