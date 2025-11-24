import { parseAbi } from "viem";
import { decodeMarkets } from "./decoder.js";
import { Chain } from "@1delta/chain-registry";
import { Lender } from "@1delta/lender-registry";
import { simulateContractRetry } from "../utils/index.js";
const MORPHO_LENS = {
    [Chain.HEMI_NETWORK]: "0x1170Ef5B1A7f9c4F0ce34Ddf66CC0e6090Fd107E",
    [Chain.BASE]: "0x05f3f58716a88A52493Be45aA0871c55b3748f18",
    [Chain.POLYGON_MAINNET]: "0x04102873b1A80647879Aa8B8a119F07aE08f457a",
    [Chain.OP_MAINNET]: "0x61895aEB0a42679E2Df8EE64334C405a8d47D244",
    [Chain.ARBITRUM_ONE]: "0xeaC918F73Ba5b11D21D31a72BD00ca4A22865C3f",
    [Chain.KATANA]: "0xCe434378adacC51d54312c872113D687Ac19B516",
    [Chain.HYPEREVM]: "0x6Bc6aCB905c1216B0119C87Bf9E178ce298310FA",
    [Chain.SONEIUM]: "0x4b5458BB47dCBC1a41B31b41e1a8773dE312BE9d",
    [Chain.ETHEREUM_MAINNET]: "0x4b5458BB47dCBC1a41B31b41e1a8773dE312BE9d",
    [Chain.BERACHAIN]: "0x7a59ddbB76521E8982Fa3A08598C9a83b14A6C07",
    [Chain.UNICHAIN]: "0xA453ba397c61B0c292EA3959A858821145B2707F",
    [Chain.SEI_NETWORK]: "0xcB6Eb8df68153cebF60E1872273Ef52075a5C297",
    [Chain.MONAD_MAINNET]: "0x0bd7473CbBf81d9dD936c61117eD230d95006CA2",
};
export const LISTA_LENS = {
    [Chain.BNB_SMART_CHAIN_MAINNET]: "0xFc98b3157f0447DfbB9FdBE7d072F7DdacA1E27C",
};
const getListUrl = (chainId) => `https://raw.githubusercontent.com/1delta-DAO/asset-lists/main/${chainId}.json`;
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
            lensAddress = LISTA_LENS[chainId];
            abi = parseAbi([
                "function getMoolahMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
            ]);
            functionName = "getMoolahMarketDataCompact";
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
            const decoded = decodeMarkets(returnData.result ?? "0x");
            decoded.forEach((market, i) => {
                const uniqueKey = markets[i];
                const { lltv, irm, oracle, loanToken, collateralToken, ...state } = market;
                if (collateralToken && loanToken && oracle) {
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
