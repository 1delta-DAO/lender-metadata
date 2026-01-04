import { parseAbi, zeroAddress } from "viem";
import { Lender } from "@1delta/lender-registry";
import { simulateContractRetry } from "../utils/index.js";
import { decodeListaMarkets, decodeMarkets, MORPHO_LENS, normalizeToBytes, } from "@1delta/margin-fetcher";
const getListUrl = (chainId) => `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;
async function getDeltaTokenList(chain) {
    const data = await fetch(getListUrl(chain));
    // @ts-ignore
    const list = (await data.json()).list;
    return list;
}
export async function getMarketsOnChain(chainId, pools, marketsListOveride = undefined) {
    const tokens = await getDeltaTokenList(chainId);
    const data = [];
    for (const [forkName, forkData] of Object.entries(pools)) {
        const poolAddress = forkData[chainId];
        if (!poolAddress)
            continue;
        let markets = [];
        let lensAddress = "";
        let abi;
        let functionName = "";
        // Determine which markets and lens to use based on fork
        if (forkName === Lender.MORPHO_BLUE) {
            markets = marketsListOveride[Lender.MORPHO_BLUE]?.[chainId] ?? [];
            lensAddress = MORPHO_LENS[chainId];
            abi = parseAbi([
                "function getMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
            ]);
            functionName = "getMarketDataCompact";
        }
        else if (forkName === Lender.LISTA_DAO) {
            markets = marketsListOveride[Lender.LISTA_DAO]?.[chainId] ?? [];
            lensAddress = MORPHO_LENS[chainId];
            abi = parseAbi([
                "function getListaMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
            ]);
            functionName = "getListaMarketDataCompact";
        }
        if (!lensAddress || markets.length === 0 || !functionName)
            continue;
        try {
            const returnData = await simulateContractRetry({
                chainId,
                abi,
                functionName,
                address: lensAddress,
                args: [poolAddress, markets],
            }, 4);
            const decoded = forkName === Lender.MORPHO_BLUE
                ? decodeMarkets(normalizeToBytes(returnData.result) ?? "0x")
                : decodeListaMarkets(normalizeToBytes(returnData.result));
            decoded.forEach((market, i) => {
                const uniqueKey = markets[i];
                const { lltv, irm, oracle, loanToken, collateralToken, ...state } = market;
                if (collateralToken &&
                    loanToken &&
                    oracle &&
                    oracle !== zeroAddress &&
                    loanToken !== zeroAddress &&
                    collateralToken !== zeroAddress) {
                    // get assets from list
                    const loanAsset = tokens[loanToken.toLowerCase()];
                    const collateralAsset = tokens[collateralToken.toLowerCase()];
                    data.push({
                        uniqueKey,
                        loanAsset,
                        lltv,
                        collateralAsset,
                        oracleAddress: oracle,
                    });
                }
            });
        }
        catch (error) {
            console.warn(`Failed to fetch ${forkName} markets for chain ${chainId}:`, error);
        }
    }
    return { markets: { items: data } };
}
