// ============================================================================
// Build bundle/lender-meta.json — every metadata file a consumer needs, in ONE
// file, so reading this dataset is one HTTP request instead of 67.
//
// WHY: @1delta/initializer-sdk fetches 67 separate raw.githubusercontent.com
// URLs to initialize. In Node that is fast (HTTP/2, no connection cap), but on
// Cloudflare Workers — where a request gets SIX connections waiting for
// response headers and the seventh queues — those 67 fetches serialize into
// ~12 rounds and land on the user's request path.
//
// The sources stay exactly as they are: ~40 independent generators each own
// their own file, diffs stay reviewable, and `FetchFlags` keeps working
// (consumers slice the bundle in memory instead of over the network). This is
// purely an additional build artifact.
//
// ── Two properties this file must keep ──────────────────────────────────────
//
// 1. DETERMINISM. There is deliberately NO timestamp, no commit SHA and no
//    build id inside the output. Identical inputs must produce a byte-identical
//    bundle, because CI commits only when `git status --porcelain` is dirty —
//    an embedded timestamp would force a ~3 MB commit EVERY NIGHT whether or
//    not any data changed, and this repo's history would grow by a gigabyte a
//    year for nothing. Consumers that need a version should use the repo's head
//    commit SHA, which is free to obtain and is the real identity of the data.
//    Keys are sorted for the same reason.
//
// 2. SCOPE. `data/` holds ~13 MB, most of which no consumer fetches
//    (lender-labels.json alone is 2.5 MB, the *-oracles-classified.json set is
//    ~5 MB). The bundle carries ONLY what bundle/manifest.json lists — the 67
//    paths the SDK actually reads, ~3.2 MB — so it never becomes a dump of the
//    whole repo.
//
// ── The drift hazard, and why it is survivable ──────────────────────────────
//
// The manifest is a hand-maintained mirror of the SDK's URL list. If the SDK
// starts reading a new file and nobody adds it here, the bundle silently lacks
// it — and a missing lender looks exactly like a lender with no markets. The
// guard is on the CONSUMER side: initializer-sdk must fall back to fetching any
// path the bundle does not carry, which turns drift into a slower read rather
// than missing data. This script additionally fails loudly when a manifest
// entry is absent from the working tree, unless it is listed as `optional`.
// ============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const manifestPath = join(repoRoot, "bundle", "manifest.json");
const outPath = join(repoRoot, "bundle", "lender-meta.json");
function main() {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const optional = new Set(manifest.optional ?? []);
    const files = {};
    const missing = [];
    const unexpectedlyMissing = [];
    // Sorted so the output is stable regardless of manifest ordering.
    for (const relPath of [...manifest.files].sort()) {
        const abs = join(repoRoot, relPath);
        if (!existsSync(abs)) {
            missing.push(relPath);
            if (!optional.has(relPath))
                unexpectedlyMissing.push(relPath);
            continue;
        }
        try {
            files[relPath] = JSON.parse(readFileSync(abs, "utf8"));
        }
        catch (err) {
            // A malformed source file must never be baked into the bundle: consumers
            // would inherit it with no way to tell it apart from real data.
            console.error(`[build-bundle] ${relPath} is not valid JSON`);
            throw err;
        }
    }
    if (unexpectedlyMissing.length > 0) {
        console.error(`[build-bundle] ${unexpectedlyMissing.length} manifest path(s) do not exist and are not marked optional:`);
        for (const p of unexpectedlyMissing)
            console.error(`  - ${p}`);
        console.error("Add the file, or add it to `optional` in bundle/manifest.json if it is genuinely unpublished.");
        process.exit(1);
    }
    // No timestamp — see the determinism note at the top.
    const bundle = { version: manifest.version, files };
    mkdirSync(dirname(outPath), { recursive: true });
    // Minified: this is a build artifact whose whole purpose is transfer size,
    // and it is reviewed through the source diffs, not through its own.
    const json = JSON.stringify(bundle);
    writeFileSync(outPath, json + "\n");
    const bytes = Buffer.byteLength(json);
    console.log(`[build-bundle] wrote bundle/lender-meta.json — ${Object.keys(files).length} files, ${(bytes / 1e6).toFixed(2)} MB`);
    if (missing.length > 0) {
        console.log(`[build-bundle] skipped ${missing.length} optional path(s): ${missing.join(", ")}`);
    }
}
main();
