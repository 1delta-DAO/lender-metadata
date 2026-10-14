# Working in this repo

## Rebuild the bundle after ANY edit to `config/` or `data/`

```bash
npm run build:bundle      # rewrites bundle/lender-meta.json
git add bundle/ && git commit ...
```

Consumers do **not** read `config/*.json` or `data/*.json`.
`@1delta/initializer-sdk` (and through it margin-fetcher, yield-tracer's
fetchers and the worker API) fetches **one** file,
`bundle/lender-meta.json`. Only if a path is missing from the bundle does it
fall back to the individual file. A source file edited without a rebuild is
therefore **invisible**. Nothing errors at commit time, nothing errors at
runtime, and the consumer keeps serving the OLD contents.

What that looks like downstream: a lender or chain you just added has **no
markets**, which is indistinguishable from a lender that really has none.

This has happened:

* **2026-10-14:** `3be610b` added LAYERBANK_V3 on Robinhood (4663) to
  `config/aave-pools.json` and pushed it straight to main without a rebuild.
  Prod fetchers resolved 4663 as `MORPHO_BLUE, RIPE, TERMMAX` only, and
  LayerBank never ingested. The Lista fixes in `2578d5b`
  (`morpho-type-markets/oracles/vaults`) were hidden the same way.
* The Midnight mainnet rollout was hidden earlier by a stale bundle in the
  same way.

The nightly `update-dataset` job rebuilds the bundle, so automated data is
safe. **Hand edits are not.** That covers new lenders, new chains, curated
allowlists and config fixes.

### Checklist for a hand edit

1. Edit the source file(s) under `config/` or `data/`.
2. `npm run build:bundle`.
3. `git diff --stat bundle/` must show `bundle/lender-meta.json` changed. If
   it did not, the file you edited is not in `bundle/manifest.json`. Add it
   there if the SDK reads it.
4. Commit the source file and the bundle **in the same commit**.

`bundle-check.yml` rebuilds and fails on a stale bundle, both on PRs and on
pushes to main. On a direct push, though, it only goes red **after** the stale
bundle is already live on `main`, which is what consumers read. Do not rely on
it; rebuild before you push.

### After the push: consumers cache

A running fetcher loads lender metadata once at boot (no TTL in
yield-tracer's `ensureInitialized`). A corrected bundle reaches prod only
after the fetcher boxes restart or redeploy. Verify the result in the data
(rows for the new lender/chain), not in this repo.
