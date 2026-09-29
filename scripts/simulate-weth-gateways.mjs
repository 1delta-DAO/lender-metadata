// ============================================================================
// Fork-simulate every configured Aave-type WETH gateway.
//
// `discover-weth-gateways.mjs verify|audit` proves a gateway is WIRED to its
// market (right wrapped native, unlimited allowance to the pool). It cannot
// prove the gateway WORKS: a V3.0-era `WrappedTokenGateway` moves `amount`
// aTokens to itself and then withdraws exactly `amount`, and on an aToken that
// rounds the scaled transfer down the gateway ends up holding `amount − 1` and
// the withdraw reverts. Whether that happens depends on the liquidity index at
// the block and on the amount — a partial native withdraw on such a market fails
// intermittently, which no static check can see.
//
// So per market this spins up an anvil fork, and as a funded fresh account:
//   depositETH(pool, account, 0){value: 1 native}
//   approve(aToken → gateway)
//   withdrawETH(pool, x, account)   for several odd x
//   withdrawETH(pool, max, account)
// and reports which legs revert. A market whose partial withdraws revert while
// max works has the rounding hazard; one whose deposit reverts is capped,
// frozen, or wired to a gateway that does not serve it.
//
// Usage:
//   node scripts/simulate-weth-gateways.mjs [chainId ...] [--proto NAME ...]
//     [--gw PROTO:CHAIN=0xgateway ...]   simulate a CANDIDATE instead of (or
//                                        besides) the configured entry
// Needs `anvil` on PATH. Read-only against the config; prints a report.
// ============================================================================

import { spawn } from "child_process";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, maxUint256, encodeFunctionData, decodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LIST_OVERRIDES } from "@1delta/providers";
import fs from "fs";

const POOLS = JSON.parse(fs.readFileSync("config/aave-pools.json", "utf8"));
const GATEWAYS = JSON.parse(fs.readFileSync("config/aave-weth-gateway.json", "utf8"));
const RESERVES = JSON.parse(fs.readFileSync("data/aave-reserves.json", "utf8"));

// anvil's first default key — a fork-only account
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(PK);

const GW = parseAbi([
  "function getWETHAddress() view returns (address)",
  "function getWXDCAddress() view returns (address)",
  "function depositETH(address,address,uint16) payable",
  "function withdrawETH(address,uint256,address)",
]);
const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
]);
const POOL_ABI = parseAbi(["function getReserveData(address) view returns (bytes)"]);

const lower = (a) => a?.toLowerCase();
// Aave V2/V3.0 revert with numeric string codes ("28" = RESERVE_FROZEN on V3,
// "3" = VL_RESERVE_FROZEN on V2, "5" = VL_NOT_ENOUGH_AVAILABLE_USER_BALANCE on
// V2); V3.2+ with these custom errors.
const CUSTOM_ERRORS = {
  "0x6d305815": "ReserveFrozen",
  "0xd37f5f1c": "ReservePaused",
  "0x90cd6f24": "ReserveInactive",
  "0xf58f733a": "SupplyCapExceeded",
  "0x47bc4b2c": "NotEnoughAvailableUserBalance",
};
const argv = process.argv.slice(2);
const chainFilter = argv.filter((a) => /^\d+$/.test(a));
const protoFilter = argv.flatMap((a, i) => (argv[i - 1] === "--proto" ? [a] : []));
const candidates = argv.flatMap((a, i) => (argv[i - 1] === "--gw" ? [a.match(/^(\w+):(\d+)=(0x[0-9a-fA-F]{40})$/)] : [])).filter(Boolean);

let port = 18545;
// Contracts compiled for osaka (CLZ) need it; a chain whose headers carry no
// prevrandao (IoTeX) needs a pre-merge fork instead: ANVIL_HARDFORK_<chainId>=london
async function startAnvil(rpc, chain) {
  const p = port++;
  const proc = spawn("anvil", ["--fork-url", rpc, "--port", String(p), "--silent", "--no-rate-limit", "--hardfork", process.env[`ANVIL_HARDFORK_${chain}`] ?? "osaka", "--base-fee", "0", "--gas-price", "0", "--disable-min-priority-fee", "--gas-limit", "60000000"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if (r.ok) return { url, stop: () => proc.kill("SIGKILL") };
    } catch {}
    await new Promise((s) => setTimeout(s, 500));
  }
  proc.kill("SIGKILL");
  return null;
}

/**
 * First RPC that answers eth_blockNumber: `RPC_<chainId>` from the environment,
 * then the providers roster. A fork makes hundreds of state reads, and the
 * public endpoints rate-limit them mid-run ("An internal error was received"),
 * so pass a keyed or gateway endpoint for any chain that matters.
 */
async function rpcFor(chain) {
  const env = process.env[`RPC_${chain}`];
  for (const url of [...(env ? env.split(",") : []), ...(LIST_OVERRIDES[chain] ?? [])]) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.result) return url;
    } catch {}
  }
  return null;
}

/**
 * aToken of W on `pool`, identified AFTER the deposit: the getReserveData word
 * (7 on V2, 8 on V3 — the V2 word 8 is the stable-debt token, which ALSO
 * reports W as its underlying) that the account now holds a balance of.
 */
async function aTokenOf(client, pool, w, holder) {
  const raw = await client.call({ to: pool, data: encodeFunctionData({ abi: parseAbi(["function getReserveData(address)"]), functionName: "getReserveData", args: [w] }) });
  const data = raw.data ?? "0x";
  for (const idx of [7, 8, 9, 10]) {
    const word = data.slice(2 + idx * 64, 2 + (idx + 1) * 64);
    if (word.length < 64 || !/^0{24}/.test(word) || /^0+$/.test(word)) continue;
    const addr = "0x" + word.slice(24);
    try {
      const u = await client.readContract({ address: addr, abi: ERC20, functionName: "UNDERLYING_ASSET_ADDRESS" });
      if (lower(u) !== lower(w)) continue;
      const bal = await client.readContract({ address: addr, abi: ERC20, functionName: "balanceOf", args: [holder] });
      if (bal > 0n) return addr;
    } catch {}
  }
  return null;
}

async function send(client, wallet, tx) {
  try {
    // 3M, or the block gas limit where that is lower (IoTeX)
    const limit = (await client.getBlock()).gasLimit;
    const hash = await wallet.sendTransaction({ ...tx, account, chain: null, gas: limit > 0n && limit < 3_000_000n ? limit : 3_000_000n, gasPrice: 0n });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status === "success") return "ok";
    // replay as a call for the reason (Aave reverts with its numeric error codes)
    try {
      await client.call({ ...tx, account: account.address, blockNumber: r.blockNumber - 1n });
      return "REVERT";
    } catch (e) {
      // Aave ≥ 3.2 reverts with custom errors; name the common ones
      const data = e.cause?.cause?.data ?? e.cause?.data ?? e.data;
      const sel = typeof data === "string" ? data.slice(0, 10) : undefined;
      if (sel && sel.length === 10 && CUSTOM_ERRORS[sel]) return `REVERT(${CUSTOM_ERRORS[sel]})`;
      const m = (e.details ?? e.shortMessage ?? "").split("\n")[0];
      return `REVERT(${m.replace(/execution reverted:?\s*/i, "").slice(0, 40)}${sel && sel.length === 10 ? ` ${sel}` : ""})`;
    }
  } catch (e) {
    return "ERR " + (e.shortMessage ?? e.message ?? "").split("\n")[0].slice(0, 60);
  }
}

async function simulate(url, proto, chain, gateway, pool) {
  const client = createPublicClient({ transport: http(url) });
  const wallet = createWalletClient({ transport: http(url), account });
  await client.request({ method: "anvil_setBalance", params: [account.address, "0x" + (10n ** 21n).toString(16)] });
  let w;
  // Fathom (XDC) names the getter after the chain's coin
  for (const functionName of ["getWETHAddress", "getWXDCAddress"]) {
    try { w = await client.readContract({ address: gateway, abi: GW, functionName }); break; } catch {}
  }
  if (!w) return { proto, chain, gateway, dep: "no getWETHAddress" };
  const out = { proto, chain, gateway };
  if (!(RESERVES[proto]?.[chain] ?? []).map(lower).includes(lower(w))) return { ...out, dep: "n/a (market does not list the wrapped native)" };
  out.dep = await send(client, wallet, { to: gateway, value: parseEther("1"), data: encodeFunctionData({ abi: GW, functionName: "depositETH", args: [pool, account.address, 0] }) });
  if (out.dep !== "ok") return out;
  const aToken = await aTokenOf(client, pool, w, account.address);
  if (!aToken) return { ...out, wd: "aToken unresolved" };
  await send(client, wallet, { to: aToken, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [gateway, maxUint256] }) });
  const legs = [];
  for (const x of ["0.123456789", "0.37", "0.0101", "0.2333333333333"]) {
    legs.push(`${x}:${await send(client, wallet, { to: gateway, data: encodeFunctionData({ abi: GW, functionName: "withdrawETH", args: [pool, parseEther(x), account.address] }) })}`);
  }
  legs.push(`max:${await send(client, wallet, { to: gateway, data: encodeFunctionData({ abi: GW, functionName: "withdrawETH", args: [pool, maxUint256, account.address] }) })}`);
  out.wd = legs.join(" ");
  out.left = String(await client.readContract({ address: aToken, abi: ERC20, functionName: "balanceOf", args: [account.address] }).catch(() => "?"));
  return out;
}

const byChain = {};
for (const [, proto, chain, gw] of candidates) {
  const pool = POOLS[proto]?.[chain]?.pool;
  if (pool) (byChain[chain] ??= []).push({ proto: `${proto}(cand)`, realProto: proto, gateway: lower(gw), pool });
}
if (!candidates.length || chainFilter.length || protoFilter.length) for (const [proto, chains] of Object.entries(GATEWAYS)) {
  if (protoFilter.length && !protoFilter.includes(proto)) continue;
  for (const [chain, gw] of Object.entries(chains)) {
    if (chainFilter.length && !chainFilter.includes(chain)) continue;
    const pool = POOLS[proto]?.[chain]?.pool;
    if (!pool) continue;
    (byChain[chain] ??= []).push({ proto, gateway: lower(gw), pool });
  }
}

const results = [];
await Promise.all(
  Object.entries(byChain).map(async ([chain, entries]) => {
    const rpc = await rpcFor(chain);
    if (!rpc) return entries.forEach((e) => results.push({ ...e, chain, dep: "no RPC" }));
    for (const e of entries) {
      // one fresh fork per market: a shared account's position would carry over
      const node = await startAnvil(rpc, chain);
      if (!node) { results.push({ ...e, chain, dep: "anvil failed" }); continue; }
      try { results.push({ ...(await simulate(node.url, e.realProto ?? e.proto, chain, e.gateway, e.pool)), proto: e.proto }); }
      catch (err) { results.push({ ...e, chain, dep: "ERR " + String(err.message).slice(0, 60) }); }
      finally { node.stop(); }
    }
  }),
);

results.sort((a, b) => Number(a.chain) - Number(b.chain) || a.proto.localeCompare(b.proto));
for (const r of results) console.log(`${`${r.proto}:${r.chain}`.padEnd(32)} ${r.gateway}  deposit=${r.dep}${r.wd ? `  withdraw ${r.wd}` : ""}${r.left ? `  aLeft=${r.left}` : ""}`);
