import { getEvmClient } from "@1delta/providers";
import { getAddress } from "viem";
const A = getAddress("0x3632E78219227b172F0aaF56F92FB08D87C94379");
const CHAINS = ["1","56","8453","42161","10","137","146","43114","1116","5000","2222","250","100","59144","534352","81457","34443","252","1329","480","130","1868","999","80094","2741","60808","43111","82","204","14","25","1284","324","9745","2345","200901","810180","747","1514","33139","5330","98866","1088","1101","288","122","1285","42220","1111","30","57073","1750","153153"];
async function main() {
  const found: string[] = [];
  await Promise.all(CHAINS.map(async (id) => {
    try {
      const c = getEvmClient(id) as any;
      const code = await c.getBytecode({ address: A });
      if (code && code.length > 4) { found.push(`${id} codesize ${code.length/2-1}`); }
    } catch (e: any) { /* no client / rpc fail */ }
  }));
  console.log(found.sort().join("\n") || "no code found on probed chains");
}
main();
