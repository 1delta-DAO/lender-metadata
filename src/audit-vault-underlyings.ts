// ============================================================================
// Audit the UNDERLYING of every Morpho-type vault for stub / dummy tokens.
//
// Motivating case: Hemi vault 0x339b3b64… (MetaMorphoV1_1) whose `asset()` is a
// 129-byte "DummyERC20" that implements only `approve()` and `decimals()` —
// a factory smoke-test deployed in the same tx as the vault. Wiring that
// underlying into the token lists would ship a token nobody can transfer.
//
// For every unique (chain, underlying) referenced by data/morpho-type-vaults.json
// (plus any extra files in the same shape passed on the command line) this
// probes on-chain, batched per chain:
//   token : code size, name(), symbol(), decimals(), totalSupply()
//   vault : name(), symbol(), totalAssets()
// and classifies the underlying:
//   no-code    — nothing deployed at the address
//   stub       — totalSupply() reverts, or name() AND symbol() both
//                revert/empty (the 129-byte DummyERC20 fingerprint is named)
//   suspicious — one of name/symbol empty, or decimals reverts
//   ok         — a plausible ERC20
// Bytecode size is reported but never flags on its own: real tokens sit behind
// 45-byte EIP-1167 clones and ~170-byte ERC1967 proxies (USDS, RLUSD, wM …),
// and chain-native token precompiles (Tempo pathUSD) have 1 byte of code.
// Chains whose multicall aggregator is missing or misbehaving (every call
// returns `0x`) fall back to direct eth_call per function.
//
// Output: JSON on stdout + a markdown table on stderr; pass --out <file> to
// write the JSON report. Chains whose RPC is unreachable are reported, not
// guessed. Read-only — never touches the data files.
//
//   pnpm exec tsx src/audit-vault-underlyings.ts [--out report.json] [extra.json ...]
// ============================================================================

import { writeFileSync } from "fs";
import { parseAbi, type Hex } from "viem";
import { getEvmClientUniversal } from "@1delta/providers";
import { readJsonFile } from "./fetch/utils/index.js";
import type { MorphoTypeVaultsByFork } from "./fetch/morpho/vaultTypes.js";
import {
  ERC20_PROBE_ABI,
  classifyTokenProbe,
  probeMulticall,
  unwrapProbe,
  type ProbeVerdict,
  type TokenProbe,
} from "./fetch/morpho/stubUnderlying.js";

const VAULTS_FILE = "./data/morpho-type-vaults.json";

// The probe transport + classifier live in fetch/morpho/stubUnderlying.ts,
// where the append jobs use the SAME rule to refuse a stub before it lands in
// the catalogue. This script only adds the code-size read and the report.

const VAULT_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
]);

type Verdict = ProbeVerdict | "unreachable";

interface VaultProbe {
  vault: string;
  fork: string;
  catalogueName?: string;
  version?: string;
  name: string | null;
  symbol: string | null;
  totalAssets: string | null;
}

interface Finding {
  chainId: string;
  underlying: string;
  verdict: Verdict;
  reasons: string[];
  token: TokenProbe;
  vaults: VaultProbe[];
}

const unwrap = unwrapProbe;
const multicall = probeMulticall;
const classify = classifyTokenProbe;

const asString = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const asNumber = (v: unknown): number | null =>
  typeof v === "bigint" || typeof v === "number" ? Number(v) : null;
const asBig = (v: unknown): string | null =>
  typeof v === "bigint" || typeof v === "number" ? String(v) : null;

const clientFor = (chainId: string, rpcId: number) => {
  try {
    return getEvmClientUniversal({ chain: chainId, rpcId, timeoutMs: 20_000 });
  } catch {
    return null;
  }
};

/** Code size per address; rotates RPC ids per address (429s are common). */
async function codeSizes(
  chainId: string,
  addresses: string[],
): Promise<(number | null)[]> {
  const clients = [0, 1, 2, 3].map((id) => clientFor(chainId, id)).filter(Boolean);
  const out: (number | null)[] = [];
  for (const address of addresses) {
    let size: number | null = null;
    for (const client of clients) {
      try {
        const code = (await client!.getCode({ address: address as Hex })) ?? "0x";
        size = (code.length - 2) / 2;
        break;
      } catch {
        /* next rpc */
      }
    }
    out.push(size);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
  const inputs = [VAULTS_FILE, ...argv.filter((a, i) => a !== "--out" && i !== outIdx + 1)];

  // (chainId, underlying) → vaults referencing it, across every input + fork.
  const byChain = new Map<string, Map<string, VaultProbe[]>>();
  for (const file of inputs) {
    const data: MorphoTypeVaultsByFork = readJsonFile(file);
    for (const [fork, chains] of Object.entries(data)) {
      for (const [chainId, vaults] of Object.entries(chains)) {
        let m = byChain.get(chainId);
        if (!m) byChain.set(chainId, (m = new Map()));
        for (const v of vaults) {
          const u = v.underlying.toLowerCase();
          let list = m.get(u);
          if (!list) m.set(u, (list = []));
          list.push({
            vault: v.vault.toLowerCase(),
            fork,
            ...(v.name ? { catalogueName: v.name } : {}),
            ...(v.version ? { version: v.version } : {}),
            name: null,
            symbol: null,
            totalAssets: null,
          });
        }
      }
    }
  }

  const totalTokens = [...byChain.values()].reduce((a, m) => a + m.size, 0);
  const totalVaults = [...byChain.values()].reduce(
    (a, m) => a + [...m.values()].reduce((b, l) => b + l.length, 0),
    0,
  );
  console.error(
    `Probing ${totalTokens} unique underlyings behind ${totalVaults} vaults on ${byChain.size} chains`,
  );

  const findings: Finding[] = [];
  const unreachable: string[] = [];

  await Promise.all(
    [...byChain.entries()].map(async ([chainId, tokens]) => {
      const addrs = [...tokens.keys()];
      const vaults = [...tokens.values()].flat();
      // A chain whose every vault was purged keeps an empty list in the
      // catalogue; nothing to probe, and not "unreachable".
      if (addrs.length === 0) return;

      const [meta, sizes, vmeta] = await Promise.all([
        multicall(
          chainId,
          addrs.flatMap((address) =>
            ["name", "symbol", "decimals", "totalSupply"].map((name) => ({
              address,
              name,
              args: [],
            })),
          ),
          ERC20_PROBE_ABI,
        ),
        codeSizes(chainId, addrs),
        multicall(
          chainId,
          vaults.flatMap(({ vault }) =>
            ["name", "symbol", "totalAssets"].map((name) => ({
              address: vault,
              name,
              args: [],
            })),
          ),
          VAULT_ABI,
        ),
      ]);

      if (meta === null || sizes.every((s) => s === null)) {
        unreachable.push(chainId);
        for (const [underlying, vs] of tokens) {
          findings.push({
            chainId,
            underlying,
            verdict: "unreachable",
            reasons: ["chain RPC unreachable"],
            token: { codeBytes: null, name: null, symbol: null, decimals: null, totalSupply: null },
            vaults: vs,
          });
        }
        return;
      }

      if (vmeta) {
        vaults.forEach((v, i) => {
          v.name = asString(unwrap(vmeta[i * 3]));
          v.symbol = asString(unwrap(vmeta[i * 3 + 1]));
          v.totalAssets = asBig(unwrap(vmeta[i * 3 + 2]));
        });
      }

      addrs.forEach((underlying, i) => {
        const token: TokenProbe = {
          codeBytes: sizes[i],
          name: meta ? asString(unwrap(meta[i * 4])) : null,
          symbol: meta ? asString(unwrap(meta[i * 4 + 1])) : null,
          decimals: meta ? asNumber(unwrap(meta[i * 4 + 2])) : null,
          totalSupply: meta ? asBig(unwrap(meta[i * 4 + 3])) : null,
        };
        const { verdict, reasons } = classify(token);
        findings.push({ chainId, underlying, verdict, reasons, token, vaults: tokens.get(underlying)! });
      });
      console.error(`  chain ${chainId}: ${addrs.length} underlyings probed`);
    }),
  );

  const order: Record<Verdict, number> = { "no-code": 0, stub: 1, suspicious: 2, unreachable: 3, ok: 4 };
  findings.sort(
    (a, b) =>
      order[a.verdict] - order[b.verdict] ||
      Number(a.chainId) - Number(b.chainId) ||
      a.underlying.localeCompare(b.underlying),
  );

  const flagged = findings.filter((f) => f.verdict !== "ok" && f.verdict !== "unreachable");
  const summary = {
    generatedAt: new Date().toISOString(),
    inputs,
    chains: byChain.size,
    uniqueUnderlyings: totalTokens,
    vaults: totalVaults,
    counts: findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.verdict] = (acc[f.verdict] ?? 0) + 1;
      return acc;
    }, {}),
    unreachableChains: unreachable.sort((a, b) => Number(a) - Number(b)),
  };

  // Markdown table of everything that is not a plain ERC20.
  const lines = [
    `| chain | underlying | verdict | code | name / symbol / dec | vaults (name · totalAssets) | reasons |`,
    `|---|---|---|---|---|---|---|`,
  ];
  for (const f of flagged) {
    const vs = f.vaults
      .map((v) => `${v.vault.slice(0, 10)}… ${v.name || v.catalogueName || "∅"} · ${v.totalAssets ?? "?"}`)
      .join("<br>");
    lines.push(
      `| ${f.chainId} | ${f.underlying} | ${f.verdict} | ${f.token.codeBytes ?? "?"}B | ${f.token.name ?? "∅"} / ${f.token.symbol ?? "∅"} / ${f.token.decimals ?? "∅"} | ${vs} | ${f.reasons.join("; ")} |`,
    );
  }
  console.error("\n" + JSON.stringify(summary, null, 2) + "\n");
  console.error(lines.join("\n"));

  const report = { summary, flagged, all: findings };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (outFile) {
    writeFileSync(outFile, json);
    console.error(`\nwrote ${outFile}`);
  } else {
    process.stdout.write(json);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
