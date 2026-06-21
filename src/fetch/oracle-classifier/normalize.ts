import { toHex } from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const VALID_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

export function isValidNonZeroAddress(addr: unknown): addr is string {
  return (
    typeof addr === "string" &&
    VALID_ADDRESS_RE.test(addr) &&
    addr.toLowerCase() !== ZERO_ADDRESS
  );
}

export function toAddr(v: unknown): string | null {
  return isValidNonZeroAddress(v) ? (v as string).toLowerCase() : null;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "0x" && v.length > 0 ? v : null;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

/**
 * Decodes a getDataFeedId() bytes32 to its UTF-8 string (RedStone encodes the ASCII symbol).
 * Accepts a hex string (multicall) or bigint (some RPC decoders).
 */
export function decodeBytes32String(raw: unknown): string | null {
  let hex: string;
  if (typeof raw === "string") {
    if (raw === "0x" || raw.length < 4) return null;
    hex = raw.length >= 66 ? raw : `0x${raw.slice(2).padEnd(64, "0")}`;
  } else if (typeof raw === "bigint") {
    hex = toHex(raw, { size: 32 });
  } else {
    return null;
  }
  const bytes = Buffer.from(hex.slice(2), "hex");
  const nullIdx = bytes.indexOf(0);
  const str = bytes
    .subarray(0, nullIdx >= 0 ? nullIdx : bytes.length)
    .toString("utf8");
  return str.length > 0 ? str : null;
}

/**
 * Normalizes RedStone feed descriptions to standard "A / B" form.
 * "RedStone Price Feed for X"     -> "X / USD"
 * "RedStone Price Feed for X/Y"   -> "X / Y"
 */
export function normalizeRedStoneDescription(desc: string): string {
  const stripped = desc.replace(/^Ojo Yield Risk Engine\s+/i, "");
  const match = stripped.match(/^RedStone Price Feed for (.+)$/i);
  if (!match) return desc;

  let content = match[1].trim();
  if (content.includes("/")) {
    const idx = content.indexOf("/");
    const base = content
      .slice(0, idx)
      .replace(/_(MAIN_)?FUNDAMENTAL$/, "")
      .replace(/_V\d+$/, "")
      .trim();
    const quote = content.slice(idx + 1).trim() || "USD";
    return `${base} / ${quote}`;
  }
  const token = content
    .replace(/_(MAIN_)?FUNDAMENTAL$/, "")
    .replace(/_V\d+$/, "")
    .trim();
  return `${token} / USD`;
}

/**
 * Extracts a clean "A / B" pair from any oracle description containing a "/".
 * Handles wrapper prefixes ("Custom price feed for WBTC / USD") and adapter
 * suffixes ("... exchange rate adapter"). Returns the description unchanged when
 * no pair can be extracted.
 */
export function normalizeGenericDescription(desc: string): string {
  // Strip common Compound / wrapper prefixes that precede the real pair.
  const prefixStripped = desc
    .replace(/^Custom price feed for\s+/i, "")
    .replace(/^Price feed for\s+/i, "")
    .trim();

  if (prefixStripped.includes("/")) {
    const idx = prefixStripped.indexOf("/");
    const A = prefixStripped.slice(0, idx).trim().split(/\s+/).pop()?.trim();
    const B = prefixStripped
      .slice(idx + 1)
      .trim()
      .split(/\s+/)[0]
      ?.trim();
    if (A && B) return `${A} / ${B}`;
  }

  // "TokenA-TokenB Exchange Rate"
  const erMatch = prefixStripped.match(/^(.+?)\s+[Ee]xchange\s+[Rr]ate$/i);
  if (erMatch) {
    const pair = erMatch[1].trim();
    const lastHyphen = pair.lastIndexOf("-");
    if (lastHyphen > 0) {
      const A = pair.slice(0, lastHyphen).trim();
      const B = pair.slice(lastHyphen + 1).trim();
      if (A && B && !A.includes(" ") && !B.includes(" ")) return `${A} / ${B}`;
    }
  }

  return desc;
}

export function normalizeDescription(desc: string): string {
  return normalizeGenericDescription(normalizeRedStoneDescription(desc));
}

export type Pair = { base: string; quote: string };

/** Parses "A / B" (or "A/B") into a base/quote pair. */
export function parsePair(desc: string | null): Pair | null {
  if (!desc) return null;
  const parts = desc.split(/\s*\/\s*/);
  if (parts.length < 2) return null;
  const base = parts[0].trim();
  const quote = parts[1].trim();
  if (!base || !quote) return null;
  return { base, quote };
}

/**
 * Token symbol aliases used when matching a feed's reported numerator against the
 * asset it is supposed to price. Wrapped/native variants and common renamings are
 * treated as equivalent (a WBTC market priced by a "BTC / USD" feed is correct).
 */
const SYMBOL_ALIASES: Record<string, string> = {
  WETH: "ETH",
  WBTC: "BTC",
  // POL is the in-place rename of MATIC — same token, interchangeable feeds.
  MATIC: "POL",
  WMATIC: "POL",
  WPOL: "POL",
  WAVAX: "AVAX",
  WBNB: "BNB",
  WS: "S",
  WXDAI: "DAI",
  XDAI: "DAI",
  "USD₮0": "USDT",
  "USDT0": "USDT",
  "USD₮": "USDT",
  // Bridged USDC (Base "USD Base Coin") priced by the USDC/USD feed.
  USDBC: "USDC",
  // MAI is the canonical symbol for miMATIC — same token, interchangeable feeds.
  MIMATIC: "MAI",
  // 1:1 wrapped BTC variants priced by the BTC/USD feed (like WBTC↔BTC).
  // NOTE: only fully-collateralized 1:1 wrappers — NOT yield-bearing derivatives
  // (cbETH, LBTC stakings, SolvBTC, etc.) which legitimately need their own feed.
  CBBTC: "BTC", // Coinbase Wrapped BTC
  BTCB: "BTC", // Binance-Peg BTC
  CBXRP: "XRP", // Coinbase Wrapped XRP
};

export function normalizeSymbol(sym: string | null | undefined): string | null {
  if (!sym) return null;
  // Strip bridged-token suffixes (Avalanche "USDC.e", BSC "...​.b", etc.) — real
  // ERC20 symbols don't contain dots, so the part before the first "." is the asset.
  const up = sym.trim().toUpperCase().split(".")[0];
  if (!up) return null;
  return SYMBOL_ALIASES[up] ?? up;
}

/** True when two token symbols refer to the same underlying asset. */
export function symbolsMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizeSymbol(a);
  const nb = normalizeSymbol(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Last resort: an unmapped wrapped token vs its native feed symbol (WRON↔RON,
  // wrsETH↔rsETH). Only strip a leading "W" when a real symbol (len>=3) remains.
  const stripW = (s: string) => (s.startsWith("W") && s.length >= 4 ? s.slice(1) : s);
  return stripW(na) === nb || na === stripW(nb) || stripW(na) === stripW(nb);
}

/**
 * Synthesizes "X / Z" from two feeds "X / Y" and "Y / Z" (multiplicative feeds),
 * cancelling the shared intermediate. Falls back to a "*"-joined description when
 * nothing cancels.
 */
export function synthesizeFromPairs(pairs: (Pair | null)[]): string | null {
  const valid = pairs.filter((p): p is Pair => p !== null);
  if (valid.length === 0) return null;
  if (valid.length === 1) return `${valid[0].base} / ${valid[0].quote}`;

  const nums = valid.map((p) => p.base);
  const denoms = valid.map((p) => p.quote);
  for (const token of [...nums]) {
    const di = denoms.indexOf(token);
    if (di !== -1) {
      nums.splice(nums.indexOf(token), 1);
      denoms.splice(di, 1);
    }
  }
  const numerator = nums.join(" * ") || "1";
  const denominator = denoms.join(" * ") || "1";
  return `${numerator} / ${denominator}`;
}
