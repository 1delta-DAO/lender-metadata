import { getEvmClient } from "@1delta/providers";
import { parseAbi } from "viem";
import { decodeMarkets } from "./decoder.js";
import { Chain } from "@1delta/chain-registry";
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
};
export const MOOLAH_LENS = {
    [Chain.BNB_SMART_CHAIN_MAINNET]: "0xFc98b3157f0447DfbB9FdBE7d072F7DdacA1E27C",
};
export const MOOLAH_MARKETS = {
    [Chain.BNB_SMART_CHAIN_MAINNET]: [
        "0x2292a4820cdf330b88ba079671484d228db4a07957db9bc24e3f1c0b42c44b84",
        "0xa6a01504ccb6a0e3832e1fae31cc4f606a7c38cd76071f27befd013b8e46e78e",
        "0x93e0995138222571035a6deadd617efad2f2400d69067a0d1fc74b179657046a",
        "0xf3a85dfdf8c44398c49401aa8f4dc3be20bff806b9da2e902d3b379790a312c6",
        "0x9a7d48f4d5a39353ff9d34c4cefc2dc933bcc11e8be1a503db0910678763c394",
        "0xb060b526bd2fc99150cff9d6f7e7fab88d5d67e35cf262215f986d62a2fba99e",
        "0x763c26da46ff4b72e38fd9935538dbdc5379996c7f9fa4489d245adf45e65eef",
        "0x78d8882695ecc12b1cbaf0e09fa681eef7f89984711e34c91a5d99f51fbe28c5",
        "0x78d4cf129bf7e4d61a53a3b1c6c6e6ecaaec4a1f3bf1c176b904b2e8ec932bb3",
        "0x4f9f51fb2cedc44d94fadafb0ebf56ce429a66e72a1d3a80e8903c7bfe09a233",
        "0x0c604931198d645ed4ebfaa5d3ced8e11528ec004ef2e6c8fb968d8fbdf902b4",
        "0x8358cc1bf5d19d624bca71db95c077420278234cc9710f9d801c2946bb3c95d5",
        "0x0e9ce37ed19824e0698b8cf1855bef55cefdc82f37c321c3812d90135f476709",
        "0x869861f50ecec64d1a75a24ebb118071c5e60122ee263e4ad44546d762c818f9",
        "0x10a30e6ecc9119aa45b79355b5c75edef77c91528131462205bbac457f3dc274",
        "0x68f3b098525f043efa59863b1e6ccfb3b9c9eaa698011af78aec0f7ee1e74958",
        "0xfff455af65ca5548a56d061aa344938b1ebf1baccef2d1ff57c59269f475539c",
        "0x1e971ef571126edf3a2cfc5bb75137b9d204c09fa4565b7397a4f2c6e79f7abe",
        "0x60e2142a6689170196ab9b6d477a44dc5ed9477957e1046da274edda8e778cd6",
        "0x9296f6b16f26036cadab212cc3569490637021728d96cd61637e7dc14525630b",
        "0x4c8c4dc9d93756111b914027d6e712aed1d3d0fa57b26332b476b245723a6b6e",
        "0xff10de0835d2f15456bc31c8a04346fa5b481ecf7d3b9d16106bbd45069ed1c1",
        "0xd9c00925089bfdfa28fd1e9ee734da1461d0b1b9bed9647f6e7ec5acb9d20fc6",
        "0x970bbb364473bace0004b4e8171f95b37e44e9103bf2d65579eaedd0f9f10294",
        "0x59bdfd8308fa61a080bfb3e8b0e9b1922248336c1d8742d5c40eecfab261685a",
        "0x97252720b962a8f6984a8a1e0d5713ac3308bf7e7ef0deaa7a49769743904b06",
        "0x92a0b35f1cdccf6e8b8f07d1ee59568f84222f38eaeef4083a359ceb4468362c",
        "0xdf9ad2d18a115cc0ee9239a174a4f0d1b22d7d1393ec71e37638f8f7be68f78c",
        "0x2bb68bc7f70186f3d4f16db6a19986df6c6cdea3e589c1ae3d30b56b0632c5ec",
        "0xe4f13e0f056e811b79ca4598bbf8756c7b5d5483e57373036674bc4d24b32a8d",
        "0x2e865d41371fb021130dc872741c70564d0f5ea4856ff1542163a8b59b0b524d",
        "0x769813deb1d1e0999fea8db4fa4b03f8ba2a822bfb082f8c30f3d9578c0acdb5",
        "0x91448288effa647bb24f0ef3eaa999d3e1007dcc76c7cdc6d8136038c7bb8fcb",
        "0x49c84acd4492ebb13e577adbd7e653fc7dfc2195af45562fc71b111722f6f02f",
        "0xed20ae46f7f909622225cdf9f301854bd46d74f639ab07bba723e5431ab27653",
        "0xcc31249ac8d2ccaa0950a812156d3aa0f06f0918ab5763d8b11a54711aac78ed",
        "0x6350ccd3fe864c1c750f2b5d99b81d1fd712250a650808d2f6e17651b1047e37",
        "0x3b13048e4b7550330862055e7c81a62b81f283111003eaa2825f54e77e35a23b",
        "0x24ef5f94def28b34f08e192a810aecd393ea4969eec031ec268de008e8a3bc70",
        "0xff66db2dcd564ed68063c779e018d25ad1a31af372bd85e4acd770d9b985f5d4",
        "0x7fed7ee489225e577836f7fc0f641359ab801292610b6afce3b47fc6087cb9e3",
        "0x9161680af48565835df016a2b2f4987a6793a545758d0379d9e0d7479db07973",
        "0x642b55769bec1f4e0d8687e24c3db885ae446f6fbb124decae96b6c0ea37f4f1",
        "0x099a8d12861248c9ab5460f21ed1169d3f5447a8432d016c75019037f24ed9cf",
        "0x699b2f053a8d301e47fdde812abaf36268b74d6f8e6b8e2d3164954b5ba8e3e5",
        "0x8a1fffce64f5b29d59e7ebfd7a927e29acdb932cc73508c9861157eeef9b8e1a",
        "0x975f4cf3db16812d995f60e19bec91a96108d47429237acc8d208bc0519c5b19",
        "0xd384584abf6504425c9873f34a63372625d46cd1f2e79aeedc77475cacaca922",
        "0x417eef8a15b54c61c64026d13ff067611579d95d392c969cac919115b5a379a2",
        "0x98736236a21390ea3697d1776974c4adcd7d8fe2961c9296cb744c3627b8b349",
        "0xfd073c4948f943af46af445c715802a711a1f6ab3fae2d902bd89ca612a98c07",
        "0xe2fac994ce98526fbc986a2f3877efddd114a09f790d679eb1cd978c3e050e55",
        "0x90607b6f2025dd56756d0e54e04e749f863f3663435949668f9c65eee1ccad7b",
        "0x174a1298d2f4a0baaef5524dfe61f4a16690eb0eddb0d3c19078acfaeda71ac4",
        "0x2b87aedf2672376147a71cf09d3b7c776f92e6c52d22a12fe1322bb205892961",
        "0xd6df9bb9ed780d18239e6ddd7c6d17f3c9bee4443149a10ec70bf8ef2a93052f",
        "0x35ce501c9de47e409c9162b1d8e515a859a7f0c6482d23746c7696fa47849edd",
        "0xf4859576d776ccbc5c7848228da8edd47902d351b1195787742bf5a2927dfe8c",
        "0x178d759d9798fe68515d6671d7230c65c2c5538b2d4e23a0e08b337e79018960",
        "0x5166d134305e09a4605c875f57c6344cc2af34e595942d112e13b5005997055d",
        "0x169a54980294ed1343d1d2bac1f279924a572ab0f2097214672565f06a275d19",
        "0x4522789ae88efdbbf289021548be7a0e98bf501f7a7765dd822090fb068cdccb",
        "0x8bf69f18eb2ad0ca4defa8e8ae8d5c1516118561e543a448dcdcdc860ed1fa47",
        "0x32f51c0ef2ab59481fc355b522c6638f39c03a820b37d981709a0a654455c1e8",
        "0xdf6046e4442d873576d16313f634a44a3a621ddc69fdf973ba5025ca427a5e5b",
        "0x5058916e33f0cd1b1e6b35943a1c322ea8ebca3cfec7636fd97bf3ad077384bb",
        "0xd2c3aaada06ed9db2cf6f74831dbc65c115c8d2652b19a66b5510f7697a77e4a",
        "0xe3fe92dd549a7ca1de5b5edf53f2d2300b0cc145390f8b06dab694380f216354",
        "0x155bad1b463ec4c4bcfd01ac96ce7d346544174da8550f93e98b6bb68377ef24",
        "0x492bef0bc2f8af11388ba0393d557a2bb9a0a17fa776746edb15ae2206071263",
        "0x0a55356620b49a0f46971fbde5663ea3cd6522fef33287bce2af46bd50d7f9ec",
        "0x1945e1e315e1d4c6f3a46186259d77c45c433ad73f9f39bb895a4f0d5702843b",
        "0xd6c21aa96745a2bbfa4c44622de70db5c6aba2e419a04e39492c3e818bf8cad5",
        "0x8df489b72324481ad81e6e34efc63ed9ad0f17ce392a9a0f62a63c7af8719cec",
        "0xb4414852df68f609f4af78d3db26d3d1b4b8b3e1ff9bf0a551a5df5512518409",
        "0x77847c67f226bb35ab9e90a2e4f7d38c843580e41189a865e6d80377680747a9",
        "0xcdac2f0341fd96b3f2c69b5a71b8575cda964716434a29805c9ce5c6914189a5",
        "0xf5851e3064736fe04791d094f24bfb1cb1890d402ab66c0c7657edc9f5a64a4a",
        "0x5dafe6bc0d68f8e449e20a982387138203cd794218edf6b88342de93da363486",
        "0xe1d29487971d885780b451e4bcec8e234149cdf641b9c2c96146445f917c3c05",
        "0xbf9b7ccbd4a052c47a80966e78d94ebcccfa42fd844ab63e4caf462a46e77463",
        "0xd50ab52aa3e0c116ce4ac0cf2e712322cef72d042c6890086f0af9c49b26cbc3",
        "0x5bd6e57058349afef09fb956734786b5b52d443bd97eb6bb9b3a5dfd8931abe6",
        "0x7024975b01054a099391a7335367b04ca419592dc0f5b94ef93d5da8d1fe570a",
        "0x7de811eba4fa1cf2f417d5d64ab3f06bae3fb900561963954ac1ae9a5d757fd8",
        "0x6d70b29dfe8c8b1f9963d8a46b756055baf6269701fb0293d117149d9deb8235",
        "0x01c052192714cc60cced5ee7b8692df04bd352fa1badc8e3b5ba1ea150d61981",
        "0x42597f4698410b304910a0942da5f3da553b4abd57cd546fdec0ad18270529d9",
        "0xe5aca112f38ec0deaa2a245d481572b123fcf61594562db46ac479939bb26785",
        "0xef5adf75aa2171a6b95fb9a09b69d6c4e2624576bfb60961a4a8f3a5e1aa9fa8",
        "0x7fd2702981745ba53bbf24343f58bcf82202ffebe3329933059731d360b2b55e",
        "0xc42d3ff5778cf2385e5c9d318824a334afeb9715dad2dcd28742b2a062798eae",
        "0x0fc58322696aed5e7684583ff7c55a0a8c58225e5ceb47e3c5536acf5138414c",
        "0xd97241d7e1f99e4375089571d6fc136596154cb8d8b894f0715839b8d10793db",
        "0xe8d896709e520cfc51e0b6fb4ed5ad35d78824f1b721719822e8a5044f6870bd",
        "0x811bf77b2067da21bfaeb2c89f71c9d1a9893d7b175b776bf363f9df4bb2604b",
        "0x70050ea2ef94b1317a2c8a9c258991f67627e55d6e04934f8de7a9fa19eb4275",
        "0x6bc2c834705eb30ba7122f5d5b5f540eb95565e42fee1c0472f3f76aedb7d12d",
    ],
};
const MORPHO_MARKETS = {
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
const getListUrl = (chainId) => `https://raw.githubusercontent.com/1delta-DAO/asset-lists/main/${chainId}.json`;
async function getDeltaTokenList(chain) {
    const data = await fetch(getListUrl(chain));
    // @ts-ignore
    const list = (await data.json()).list;
    return list;
}
export async function getMarketsOnChain(chainId, pools) {
    const tokens = await getDeltaTokenList(chainId);
    const provider = getEvmClient(chainId);
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
        if (forkName === "MORPHO_BLUE") {
            markets = MORPHO_MARKETS[chainId] ?? [];
            lensAddress = MORPHO_LENS[chainId];
            abi = parseAbi(["function getMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)"]);
            functionName = "getMarketDataCompact";
        }
        else if (forkName === "MOOLAH") {
            markets = MOOLAH_MARKETS[chainId] ?? [];
            lensAddress = MOOLAH_LENS[chainId];
            abi = parseAbi([
                "function getMoolahMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
            ]);
            functionName = "getMoolahMarketDataCompact";
        }
        if (!lensAddress || markets.length === 0 || !functionName)
            continue;
        try {
            const returnData = await provider.simulateContract({
                abi,
                functionName,
                address: lensAddress,
                args: [poolAddress, markets],
            });
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
