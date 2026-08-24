import { readFileSync } from "node:fs";
import { getEvmClient } from "@1delta/providers";
import { encodeFunctionData, getAddress } from "viem";
const ABI = [{inputs:[{type:"address"}],name:"cTokenMetadata",outputs:[{type:"bytes"}],stateMutability:"nonpayable",type:"function"}] as const;
const CASES: [string,string,string,string][] = [
  ["DEMETER","56","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a","cream-bsc"],
  ["LANDER","56","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a","cream-bsc"],
  ["FILDA","56","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a","cream-bsc"],
  ["SOLIDLIZARD","42161","0x139Dd8Bb6355d20342e08ff013150b1aE5040a42","cream-poly-arb"],
  ["SOLIDLIZARD","42161","0x24C25910aF4068B5F6C3b75252a36c4810849135","lodestar-arb"],
  ["SOLIDLIZARD","42161","0x14Ec7324753340Bd8685496da14c4B173ac05b18","tender-arb"],
  ["CREAM_FINANCE","56","0x1A014Ffe0cd187A298a7E79BA5ab05538686ea4a","cream-bsc (control)"],
  ["TENDER","42161","0x14Ec7324753340Bd8685496da14c4B173ac05b18","tender-arb (control)"],
];
async function main() {
  const tokens = JSON.parse(readFileSync("./data/compound-v2-tokens.json","utf8"));
  for (const [fork, chain, lens, label] of CASES) {
    const tk = tokens[fork]?.[chain]?.[0]?.cToken;
    if (!tk) { console.log(fork, chain, "no token"); continue; }
    const c = getEvmClient(chain) as any;
    const data = encodeFunctionData({ abi: ABI, functionName: "cTokenMetadata", args: [getAddress(tk)] });
    try {
      const r = await c.call({ to: getAddress(lens), data });
      const bytes = ((r.data?.length ?? 2) - 2) / 2;
      console.log(`${fork}/${chain}`.padEnd(20), label.padEnd(22), `${bytes} bytes → ${bytes/32} words → ${(bytes/32)-1} fields (offset+tuple)`);
    } catch (e:any) { console.log(`${fork}/${chain}`.padEnd(20), label.padEnd(22), "ERR", String(e.shortMessage??e.message).split("\n")[0].slice(0,50)); }
  }
}
main();
