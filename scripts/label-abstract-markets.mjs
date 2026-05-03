// One-off: generate Morpho Blue market labels for Abstract (chain 2741) by
// pulling each market's params from Morpho on-chain and resolving token
// symbols via multicall. Appends names + shortNames to data/lender-labels.json.

import { createPublicClient, http, parseAbi, getAddress } from "viem";
import fs from "node:fs";
import path from "node:path";

const RPC = "https://api.mainnet.abs.xyz";
const MORPHO = "0xc85CE8ffdA27b646D269516B8d0Fa6ec2E958B55";
const CHAIN_ID = "2741";
const FORK = "MORPHO_BLUE";

const LABELS_FILE = "./data/lender-labels.json";
const MARKETS_FILE = "./config/morpho-type-markets.json";

const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
]);

const client = createPublicClient({
  chain: {
    id: 2741,
    name: "Abstract",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  },
  transport: http(RPC),
});

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ids = JSON.parse(fs.readFileSync(path.join(repoRoot, MARKETS_FILE), "utf8"))[FORK][CHAIN_ID];
console.log(`Loading params for ${ids.length} Abstract markets...`);

const params = await client.multicall({
  contracts: ids.map((id) => ({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id] })),
  allowFailure: false,
});

const tokens = new Set();
for (const p of params) {
  tokens.add(getAddress(p[0]));
  tokens.add(getAddress(p[1]));
}
const tokenList = [...tokens];
console.log(`Resolving symbols for ${tokenList.length} unique tokens...`);

const symbols = await client.multicall({
  contracts: tokenList.map((address) => ({ address, abi: erc20Abi, functionName: "symbol" })),
  allowFailure: true,
});
const symMap = new Map();
tokenList.forEach((addr, i) => {
  symMap.set(addr, symbols[i].status === "success" ? symbols[i].result : addr.slice(0, 6));
});

const labels = JSON.parse(fs.readFileSync(path.join(repoRoot, LABELS_FILE), "utf8"));
labels.names ??= {};
labels.shortNames ??= {};

let added = 0, updated = 0;
for (let i = 0; i < ids.length; i++) {
  const [loan, coll, , , lltv] = params[i];
  const loanSym = symMap.get(getAddress(loan));
  const collSym = symMap.get(getAddress(coll));
  const bps = Math.round((Number(lltv) / 1e18) * 100).toString();
  const key = `${FORK}_${ids[i].slice(2).toUpperCase()}`;
  const longName = `Morpho ${collSym}-${loanSym} ${bps}`;
  const shortName = `MB ${collSym}-${loanSym} ${bps}`;
  const wasNew = !(key in labels.names);
  if (labels.names[key] !== longName) {
    labels.names[key] = longName;
    if (wasNew) added++; else updated++;
  }
  labels.shortNames[key] = shortName;
  console.log(`${ids[i]}  ${longName}`);
}

labels.names = Object.fromEntries(Object.entries(labels.names).sort(([a],[b]) => a.localeCompare(b)));
labels.shortNames = Object.fromEntries(Object.entries(labels.shortNames).sort(([a],[b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(repoRoot, LABELS_FILE), JSON.stringify(labels, null, 2) + "\n");
console.log(`\nadded=${added} updated=${updated}`);
