// ============================================================================
// Print the set of lending-data token addresses that are missing from the
// 1delta-DAO token lists, grouped by chain id. Output is JSON on stdout so it
// can be piped into a batch token-detail fetcher elsewhere.
// ============================================================================

import { collectMissingLendingTokens } from "./fetch/missing-tokens.js";

async function main(): Promise<void> {
  const missing = await collectMissingLendingTokens();
  process.stdout.write(JSON.stringify(missing, null, 2) + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
