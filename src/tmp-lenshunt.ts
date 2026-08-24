import { readFileSync, writeFileSync } from "node:fs";
import { getEvmClient } from "@1delta/providers";
import { getAddress } from "viem";

const CANDIDATES: [string,string][] = [
  ["cream-eth/robust","0x92ee472A52A79AB407aED9FE0deB512d230baF87"],
  ["cream-bsc","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a"],
  ["cream-poly-arb","0x139Dd8Bb6355d20342e08ff013150b1aE5040a42"],
  ["compound-og-eth","0xd513d22422a3062Bd342Ae374b4b9c20E0a9a074"],
  ["lodestar-arb","0x24C25910aF4068B5F6C3b75252a36c4810849135"],
  ["tender-arb","0x14Ec7324753340Bd8685496da14c4B173ac05b18"],
  ["wepiggy-eth","0x2910d8cb5A889a22cc88354116DFFb1a3AD8a0E2"],
  ["wepiggy-bsc","0x560dD9b47d40E0cd0aEDA326e46BeD25249d936A"],
  ["gamma-bsc","0xcaf6856f6Ec1B66EE89dD296D2020dfA431D8f6B"],
];
const T14 = ["address","uint256","uint256","uint256","uint256","uint256","uint256","uint256","uint256","bool","uint256","address","uint256","uint256"];
const T17 = [...T14,"uint256","uint256","uint256"];
const lensAbi = (types: string[]) => [{
  inputs:[{type:"address"}], name:"cTokenMetadata",
  outputs:[{ type:"tuple", components: types.map((t,i)=>({name:`f${i}`, type:t})) }],
  stateMutability:"nonpayable", type:"function",
}];
const TARGETS: [string,string][] = JSON.parse(process.argv[2]);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main() {
  const tokens = JSON.parse(readFileSync("./data/compound-v2-tokens.json","utf8"));
  const out: any[] = [];
  for (const [fork, chain] of TARGETS) {
    const mk = tokens[fork]?.[chain]?.[0]?.cToken;
    if (!mk) { console.log(`${fork}/${chain}: no market`); continue; }
    const c = getEvmClient(chain) as any;
    const hits: string[] = [];
    for (const [name, addr] of CANDIDATES) {
      let code: string | undefined;
      try { code = await c.getBytecode({ address: getAddress(addr) }); } catch { continue; }
      if (!code || code.length < 6) continue;
      for (const [label, types] of [["14f",T14],["17f",T17]] as [string,string[]][]) {
        try {
          const r = await c.simulateContract({ address: getAddress(addr), abi: lensAbi(types), functionName: "cTokenMetadata", args: [getAddress(mk)] });
          const v: any = r.result;
          if (String(v.f0).toLowerCase() === mk.toLowerCase()) { hits.push(`${name}(${label}) ${addr}`); break; }
        } catch { /* not this shape */ }
      }
      await sleep(60);
    }
    console.log(`${fork}/${chain}`.padEnd(26), hits.length ? "LENS: " + hits.join(" | ") : "no known lens works");
    out.push({ fork, chain, hits });
  }
  writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
}
main();
