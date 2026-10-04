import { parseAbi, zeroAddress } from "viem";
import { Lender } from "@1delta/lender-registry";
import { multicallRetryUniversal } from "@1delta/providers";
import {
  decodeListaMarkets,
  decodeMarkets,
  MORPHO_LENS,
  normalizeToBytes,
} from "@1delta/margin-fetcher";

const getListUrl = (chainId: string) =>
  `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;

async function getDeltaTokenList(chain: string) {
  const data = await fetch(getListUrl(chain));
  // @ts-ignore
  const list = (await data.json()).list as GenericTokenList;
  return list;
}

const ERC20_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const unwrapResult = (r: unknown) =>
  r && typeof r === "object" && "result" in (r as any) ? (r as any).result : r;

/**
 * symbol()/decimals() for tokens the token list does not carry. A token whose
 * decimals cannot be read is left out (its market stays unresolved, as before):
 * the triplet needs exact decimals, a guess would misprice the oracle check.
 */
async function readErc20Meta(
  chainId: string,
  addresses: string[]
): Promise<Map<string, { address: string; symbol: string; decimals: number }>> {
  const out = new Map<string, { address: string; symbol: string; decimals: number }>();
  try {
    const res = (await multicallRetryUniversal({
      chain: chainId,
      calls: addresses.flatMap((address) => [
        { address, name: "symbol", args: [] },
        { address, name: "decimals", args: [] },
      ]),
      abi: ERC20_META_ABI,
      allowFailure: true,
    })) as unknown[];
    addresses.forEach((address, i) => {
      const sym = unwrapResult(res[2 * i]);
      const dec = unwrapResult(res[2 * i + 1]);
      const decimals = typeof dec === "number" ? dec : typeof dec === "bigint" ? Number(dec) : NaN;
      if (!Number.isInteger(decimals)) return;
      out.set(address, {
        address,
        // A reverted symbol() comes back as raw "0x" data under allowFailure.
        symbol:
          typeof sym === "string" && sym.length > 0 && !/^0x[0-9a-f]*$/i.test(sym)
            ? sym
            : "unknown",
        decimals,
      });
    });
  } catch (e) {
    console.warn(`[morpho on-chain] chain ${chainId}: token metadata read failed:`, (e as Error).message);
  }
  return out;
}

export async function getMarketsOnChain(
  chainId: string,
  pools: any,
  marketsListOveride: any = undefined
) {
  // A chain with no token list (or a failed fetch) still resolves through the
  // on-chain metadata fallback below.
  const tokens: Record<string, any> =
    ((await getDeltaTokenList(chainId).catch(() => undefined)) as any) ?? {};

  const data: any[] = [];

  for (const [forkName, forkData] of Object.entries(pools)) {
    const poolAddress = (forkData as any)[chainId];
    if (!poolAddress) continue;

    let markets: string[] = [];
    let lensAddress: string = "";
    let abi: any;
    let functionName: string = "";

    // Determine which markets and lens to use based on fork
    if (forkName === Lender.MORPHO_BLUE) {
      markets = marketsListOveride[Lender.MORPHO_BLUE]?.[chainId] ?? [];
      lensAddress = MORPHO_LENS[chainId];
      abi = parseAbi([
        "function getMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
      ]);
      functionName = "getMarketDataCompact";
    } else if (forkName === Lender.LISTA_DAO) {
      markets = marketsListOveride[Lender.LISTA_DAO]?.[chainId] ?? [];
      lensAddress = MORPHO_LENS[chainId];
      abi = parseAbi([
        "function getListaMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
      ]);
      functionName = "getListaMarketDataCompact";
    }

    if (!lensAddress || markets.length === 0 || !functionName) continue;

    try {
      const results = await multicallRetryUniversal({
        chain: chainId,
        calls: [
          {
            address: lensAddress,
            name: functionName,
            args: [poolAddress, markets],
          },
        ],
        abi,
        allowFailure: false,
      });

      const returnData = results[0];
      const decoded =
        forkName === Lender.MORPHO_BLUE
          ? decodeMarkets(
              normalizeToBytes(returnData as unknown as string) ?? "0x"
            )
          : decodeListaMarkets(
              normalizeToBytes(returnData as unknown as string)
            );

      // Tokens missing from the 1delta token list used to make the whole
      // market vanish (no loan/collateral object → no triplet, no label), e.g.
      // the $1.1B-nominal USDC/xUSD market on Plume, whose collateral (Stream
      // xUSD) is not listed there. Read symbol/decimals on-chain for those.
      const missing = [
        ...new Set(
          decoded
            .flatMap((m: any) => [m.loanToken, m.collateralToken])
            .filter((a: any) => a && a !== zeroAddress)
            .map((a: string) => a.toLowerCase())
            .filter((a: string) => !tokens[a])
        ),
      ] as string[];
      if (missing.length > 0) {
        const extra = await readErc20Meta(chainId, missing);
        for (const [a, meta] of extra) tokens[a] = meta;
      }

      decoded.forEach((market, i) => {
        const uniqueKey = markets[i];
        const { lltv, irm, oracle, loanToken, collateralToken, ...state } =
          market;
        if (
          collateralToken &&
          loanToken &&
          oracle &&
          oracle !== zeroAddress &&
          loanToken !== zeroAddress &&
          collateralToken !== zeroAddress
        ) {
          // get assets from list
          const loanAsset = tokens[loanToken.toLowerCase()];
          const collateralAsset = tokens[collateralToken.toLowerCase()];
          data.push({
            uniqueKey,
            loanAsset,
            lltv,
            collateralAsset,
            oracleAddress: oracle,
            // `listed` mirrors the API/subgraph flag that consumers gate on
            // (MorphoBlueUpdater drops any market where it is falsy, so an
            // absent flag means the chain contributes NO oracle entries at
            // all). There is no listing concept on-chain: every market here
            // was read straight out of the core, so existence IS the flag.
            listed: true,
          });
        }
      });
    } catch (error) {
      console.warn(
        `Failed to fetch ${forkName} markets for chain ${chainId}:`,
        error
      );
    }
  }
  return { markets: { items: data } };
}
