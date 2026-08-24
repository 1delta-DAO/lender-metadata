import { readFileSync } from "node:fs";
import { getEvmClient } from "@1delta/providers";
import { getAddress } from "viem";
const ABI = [{
  inputs:[{type:"address",name:"cToken"}], name:"cTokenMetadata",
  outputs:[{type:"tuple", components:[
    {name:"cToken",type:"address"},{name:"exchangeRateCurrent",type:"uint256"},{name:"supplyRatePerBlock",type:"uint256"},
    {name:"borrowRatePerBlock",type:"uint256"},{name:"reserveFactorMantissa",type:"uint256"},{name:"totalBorrows",type:"uint256"},
    {name:"totalReserves",type:"uint256"},{name:"totalSupply",type:"uint256"},{name:"totalCash",type:"uint256"},
    {name:"isListed",type:"bool"},{name:"collateralFactorMantissa",type:"uint256"},{name:"underlyingAssetAddress",type:"address"},
    {name:"cTokenDecimals",type:"uint256"},{name:"underlyingDecimals",type:"uint256"}]}],
  stateMutability:"nonpayable", type:"function"}] as const;
const CASES: [string,string,string][] = [
  ["DEMETER","56","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a"],
  ["LANDER","56","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a"],
  ["FILDA","56","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a"],
  ["SOLIDLIZARD","42161","0x14Ec7324753340Bd8685496da14c4B173ac05b18"],
];
async function main() {
  const tokens = JSON.parse(readFileSync("./data/compound-v2-tokens.json","utf8"));
  for (const [fork, chain, lens] of CASES) {
    const c = getEvmClient(chain) as any;
    for (const e of tokens[fork][chain].slice(0,3)) {
      const r = await c.simulateContract({ address: getAddress(lens), abi: ABI, functionName: "cTokenMetadata", args: [getAddress(e.cToken)] });
      const v: any = r.result;
      const underlyingOk = v.underlyingAssetAddress.toLowerCase() === e.underlying.toLowerCase();
      console.log(`${fork}/${chain}`.padEnd(18), e.cToken.slice(0,10),
        "listed", v.isListed, "cf", (Number(v.collateralFactorMantissa)/1e18).toFixed(2),
        "cDec", String(v.cTokenDecimals), "uDec", String(v.underlyingDecimals),
        "underlying match:", underlyingOk ? "OK" : `MISMATCH ${v.underlyingAssetAddress} vs ${e.underlying}`);
    }
  }
}
main();
