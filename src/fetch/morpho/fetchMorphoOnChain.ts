import { getEvmClient } from "@1delta/providers";
import { parseAbi } from "viem";
import { decodeMarkets } from "./decoder.js";
import { Chain } from "@1delta/chain-registry";

const MORPHO_LENS: { [c: string]: string } = {
  [Chain.HEMI_NETWORK]: "0x1170Ef5B1A7f9c4F0ce34Ddf66CC0e6090Fd107E",
  [Chain.BASE]: "0x05f3f58716a88A52493Be45aA0871c55b3748f18",
  [Chain.POLYGON_MAINNET]: "0x04102873b1A80647879Aa8B8a119F07aE08f457a",
  [Chain.OP_MAINNET]: "0x61895aEB0a42679E2Df8EE64334C405a8d47D244",
  [Chain.ARBITRUM_ONE]: "0xeaC918F73Ba5b11D21D31a72BD00ca4A22865C3f",
  [Chain.KATANA]: "0xCe434378adacC51d54312c872113D687Ac19B516",
  [Chain.HYPEREVM]: "0x6Bc6aCB905c1216B0119C87Bf9E178ce298310FA",
  [Chain.SONEIUM]: "0x4b5458BB47dCBC1a41B31b41e1a8773dE312BE9d",
  [Chain.ETHEREUM_MAINNET]: "0x4b5458BB47dCBC1a41B31b41e1a8773dE312BE9d",
};

const MORPHO_MARKETS: { [chain: string]: string[] } = {
  [Chain.HYPEREVM]: [
    "0x076689a210adf3fdaa54e8ed452615ed641ba0d985f95e1376c3df3017d62878",
    "0x09ed416b38a29e077383da5ae4200523e54e33ecff6e148c2590969a9852513f",
    "0x0a2e456ebd22ed68ae1d5c6b2de70bc514337ac588a7a4b0e28f546662144036",
    "0x0bb2900086fe38fa9633c664e1f955eb8dcf66a81174967e83dee867e083a105",
    "0x0ecf5be1fadf4bec3f79ce196f02a327b507b34d230c0f033f4970b1b510119c",
    "0x15f505f8dda26a523f7490ad0322f3ed4f325a54fd50832bc65e4bd75e3dca54",
    "0x19bbcc95b876740c0765ed1e4bac1979c4aea1b4bfbfee0e61dc1fe76a6887dc",
    "0x19e47d37453628ebf0fd18766ce6fee1b08ea46752a5da83ca0bfecb270d07e8",
    "0x1c6b87ae1b97071ef444eedcba9f5a92cfe974edbbcaa1946644fc7ab0e283af",
    "0x1da89208e6cb5173e97a83461853b8400de4f7c37542cf010a10579a5f7ca451",
    "0x1df0d0ebcdc52069692452cb9a3e5cf6c017b237378141eaf08a05ce17205ed6",
    "0x216bd19960f140177a4a3fb9cf258edcbadb1f5d54740fc944503bff4a00e65e",
    "0x2acd218c67daa94dd2f92e81f477ffc9f8507319f0f2d698eae5ed631ae14039",
    "0x2b62c4153d81d5b5a233d1d2b7ef899d3fca4076d458e215ff3a00176b415b0d",
    "0x31aaa663d718e83ea15326ec110c4bcf5e123585d0b6c4d0ad61a50c4aa65b1e",
    "0x33c935bb0699b737d9cbd4274b5936a9004eee03ccfa70e266ff7c1513fd4808",
    "0x45af9c72aa97978e143a646498c8922058b7c6f18b6f7b05d7316c8cf7ab942f",
    "0x5031ac4543f8232df889e5eb24389f8cf9520366f21dc62240017cb3bc6ecc59",
    "0x53bf81793c2cc384c19a3bc9b032467e179a390a9225cd9542742ac10f539cc2",
    "0x5ecb7a25d51c870ec57f810c880e3e20743e56d0524575b7b8934a778aaec1af",
    "0x5ef35fe4418a6bcfcc70fe32efce30074f22e9a782f81d432c1e537ddbda11e2",
    "0x64e7db7f042812d4335947a7cdf6af1093d29478aff5f1ccd93cc67f8aadfddc",
    "0x65f2a559764859a559d8c39604cf665942bab7d10dfaa1b82e914c9d351038d4",
    "0x6eb4ce92dc1d89abd40f9634249ec28e8ab4e3f9bef0ab47ea784773c140d4ef",
    "0x707dddc200e95dc984feb185abf1321cabec8486dca5a9a96fb5202184106e54",
    "0x725d0f4c005c0a521ea5005bb4730845ff0d4cc76b40a618103b103cddd1f951",
    "0x7268244d330f1462f77ded7a14e2f868893e86e76e8b8eaa869405d588aff6ce",
    "0x78f6b57d825ef01a5dc496ad1f426a6375c685047d07a30cd07ac5107ffc7976",
    "0x83bab0d612f592d0f145b2ec82fd730144dfb3d72c8fc838b27555558e49c496",
    "0x888679b2af61343a4c7c0da0639fc5ca5fc5727e246371c4425e4d634c09e1f6",
    "0x8eb8cfe3b1ac8f653608ae09fb099263fa2fe25d4a59305c309937292c2aeee9",
    "0x964e7d1db11bdf32262c71274c297dcdb4710d73acb814f04fdca8b0c7cdf028",
    "0x9e28003bb5c29c1df3552e99b04d656fadf1aedaf81256637dcc51d91cf6c639",
    "0xa24d04c3aff60d49b3475f0084334546cbf66182e788b6bf173e6f9990b2c816",
    "0xa62327642e110efd38ba2d153867a8625c8dc40832e1d211ba4f4151c3de9050",
    "0xa7fe39c692f0192fb2f281a6cc16c8b2e1c8f9b9f2bc418e0c0c1e9374bf4b04",
    "0xace279b5c6eff0a1ce7287249369fa6f4d3d32225e1629b04ef308e0eb568fb0",
    "0xb142d65d7c624def0a9f4b49115b83f400a86bd2904d4f3339ec4441e28483ea",
    "0xb5b575e402c7c19def8661069c39464c8bf3297b638e64d841b09a4eb2807de5",
    "0xbc15a1782163f4be46c23ac61f5da50fed96ad40293f86a5ce0501ce4a246b32",
    "0xc5526286d537c890fdd879d17d80c4a22dc7196c1e1fff0dd6c853692a759c62",
    "0xc59a3f8a3918d89ebef44ee1dcda435719f543cfd3f37ead7e74852ea5931581",
    "0xd13b1bad542045a8dc729fa0ffcc4f538b9771592c2666e1f09667dcf85804fc",
    "0xd173e9d80aeacac486b46a9a849ecb386cec260cc7dd5be0db3505a0f9f93fb5",
    "0xd2e8f6fd195556222d7a0314d4fb93fdf84ae920faaebba6dbcf584ac865e1f5",
    "0xd5a9fba2309a0b85972a96f2cc45f9784e786d712944d8fc0b31a6d9cb4f21d3",
    "0xd5c5b5db889eb5d4f4026b9704cddffbc1356732a37c2b543330c10756ae7a18",
    "0xdb2cf3ad3ef91c9bb673bf35744e7141bc2950b27a75c8d11b0ead9f6742d927",
    "0xe0ede98b4425285a9c93d51f8ba27d9a09bc0033874e4a883d3f29d41f9f2e4a",
    "0xe41ace68f2de7be8e47185b51ddc23d4a58aac4ce9f8cc5f9384fe26f2104ec8",
    "0xe7aa046832007a975d4619260d221229e99cc27da2e6ef162881202b4cd2349b",
    "0xe9a9bb9ed3cc53f4ee9da4eea0370c2c566873d5de807e16559a99907c9ae227",
    "0xebeabb17bd69d4b8ed6929a821d69478b564f4cc604d0995944c9da8b5cb3f04",
    "0xed00791e29eb08c9bc0d8b389fe1f00084699baf2a785ba2a42e915706b17b82",
    "0xf25db2433ae650155eae04ebd8b3795d19bfcb318d22926a8a5e746e8028e0a8",
    "0xf9f0473b23ebeb82c83078f0f0f77f27ac534c9fb227cb4366e6057b6163ffbf",
    "0xfbe436e9aa361487f0c3e4ff94c88aea72887a4482c6b8bcfec60a8584cdb05e",
    "0xfdece686f16877984325c7a1c192e0f18862bae3829d000a1a62b5bc2b31d4ef",
    "0xb1977ea63bed73a2b1259889cd6c846e1fa869aa3236f86938588b4b3bd68b7d",
    "0xae019cf2bf3d650ab4037986405c80ebb83fec18fb120c71bf8889d327caef0f",
    "0xfea758e88403739fee1113b26623f43d3c37b51dc1e1e8231b78b23d1404e439",
    "0xb5b215bd2771f5ed73125bf6a02e7b743fadc423dfbb095ad59df047c50d3e81",
    "0xc0a3063a0a7755b7d58642e9a6d3be1c05bc974665ef7d3b158784348d4e17c5",
    "0x292f0a3ddfb642fbaadf258ebcccf9e4b0048a9dc5af93036288502bde1a71b1",
    "0x96c7abf76aed53d50b2cc84e2ed17846e0d1c4cc28236d95b6eb3b12dcc86909",
    "0x5fe3ac84f3a2c4e3102c3e6e9accb1ec90c30f6ee87ab1fcafc197b8addeb94c",
    "0x87272614b7a2022c31ddd7bba8eb21d5ab40a6bcbea671264d59dc732053721d",
    "0xb39e45107152f02502c001a46e2d3513f429d2363323cdaffbc55a951a69b998",
    "0x1f79fe1822f6bfe7a70f8e7e5e768efd0c3f10db52af97c2f14e4b71e3130e70",
    "0xe500760b79e397869927a5275d64987325faae43326daf6be5a560184e30a521",
    "0x86d7bc359391486de8cd1204da45c53d6ada60ab9764450dc691e1775b2e8d69",
    "0x920244a8682a53b17fe15597b63abdaa3aecec44e070379c5e43897fb9f42a2b",
    "0xd4fd53f612eaf411a1acea053cfa28cbfeea683273c4133bf115b47a20130305",
    "0xe0a1de770a9a72a083087fe1745c998426aaea984ddf155ea3d5fbba5b759713",
    "0x41afe1000213f119a3d8a6cd2f9fc0b564a58f948514e4cc246f6293bbed3409",
    "0x583e3beb5d64b419c68083555bb7bbcc018ec392289742d5535c3916041c2f5e",
    "0x1f97b6313f322ddb58a7db22896fcd588dae009c5f67e8441a00613b990950eb",
    "0xbb72791441e499bb05931b2629964114cc97f197897128efc276a76a10d73ac6",
    "0x4ec715887ec2b7470a7e33f7cb0035677db3e8882a680cc09053b8ad53f47154",
  ],
  [Chain.OP_MAINNET]: [
    "0x173b66359f0741b1c7f1963075cd271c739b6dc73b658e108a54ce6febeb279b",
    "0x67840b3ace736fe47ab919ad003e0330da50536f61f9fcb96af80d0f37a57070",
    "0xc7ae57c1998c67a4c21804df606db1309b68a518ba5acc8b1dc3ffcb1b26b071",
  ],
  [Chain.SONEIUM]: [
    "0xc35eda4e57363a5679949be05c65b81c2c274bfcd21173344d99726147236614",
    "0x80a26251892573c16d88f2aabd447bc46d918daa035e1bbaedc9ca315bfb3275",
    "0x87f0a5e65f1cfb879d2d5e7300691332ba227f3babe8fbd4bd2cbca862d8ae5e",
    "0xebaf3dc6fa2fb3f78d18c87adcc37c06fe64874c5b2d69619ef7696088780df9",
    "0x5869019d7ec9f92db2e90c0156b542cda7c0a679c626eac842aa5117a0483d4a",
  ],
  [Chain.HEMI_NETWORK]: [
    "0x36931ab4ffe6fed55ab0624afd2bf6eb1cebdbd6d5c98334e949841e402f86ff",
    "0x08abb2b634eb6454a5819dbaa5c0229136989a9990ed757727c406dbcb4e606b",
    "0xf1b97d86baa12ef4622eeca186a49fa7f7ea1ac2aa55ea4c20a26e815ddd6bc6",
    "0xb7dd4c2e7c164de474b28c354cddb137deb0ce2583b925d20c33322074c22178",
    "0x4b670128dfaa02a92f833bb9b99949262b685c2d3f55d4f7c97da1849d2b6355",
    "0x7c985a3ba92fa76a362f661b37a68c9955490eb659b7905aab6019b91042b452",
  ],
};

const getListUrl = (chainId: string) =>
  `https://raw.githubusercontent.com/1delta-DAO/asset-lists/main/${chainId}.json`;

async function getDeltaTokenList(chain: string) {
  const data = await fetch(getListUrl(chain));
  // @ts-ignore
  const list = (await data.json()).list as GenericTokenList;
  return list;
}

export async function getMarketsOnChain(chainId: string, pools: any) {
  const markets = MORPHO_MARKETS[chainId] ?? [];
  const tokens = await getDeltaTokenList(chainId);
  const abi = parseAbi([
    "function getMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
  ]);
  const provider = getEvmClient(chainId);

  const mb = pools.MORPHO_BLUE?.[chainId];
  if (!mb) return [];

  const returnData = await provider.simulateContract({
    abi,
    functionName: "getMarketDataCompact",
    address: MORPHO_LENS[chainId] as any,
    args: [mb, markets] as any,
  });

  const decoded = decodeMarkets(returnData.result ?? "0x");

  const data: any[] = [];
  decoded.forEach((market, i) => {
    const uniqueKey = markets[i];
    const { lltv, irm, oracle, loanToken, collateralToken, ...state } = market;
    if (collateralToken && loanToken && oracle) {
      const m = "MORPHO_BLUE_" + uniqueKey.slice(2).toUpperCase();
      // @ts-ignore
      if (!data[m]) data[m] = { data: {} };
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

  return { markets: { items: data } };
}
