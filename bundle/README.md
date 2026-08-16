# bundle/

`lender-meta.json` is every metadata file a consumer needs, in one file.

```
https://raw.githubusercontent.com/1delta-DAO/lender-metadata/main/bundle/lender-meta.json
```

~2.6 MB, **~0.71 MB gzipped** (raw.githubusercontent.com serves gzip). One
request instead of 67.

## Why

`@1delta/initializer-sdk` fetches 67 separate raw URLs to initialize. In Node
that costs ~240 ms — HTTP/2, no connection cap. On Cloudflare Workers it does
not: a request gets **six connections simultaneously waiting for response
headers** and queues the seventh, so 67 fetches become ~12 serialized rounds on
the user's request path.

The sources are unchanged. ~40 independent generators still own their own files,
diffs stay reviewable, and `FetchFlags` still works — consumers slice the bundle
in memory instead of over the network, which is strictly cheaper than today.
This is an additional build artifact, not a migration.

## Shape

```jsonc
{
  "version": 1,
  "files": {
    "config/aave-pools.json": { /* verbatim contents */ },
    "data/aave-tokens.json":  { /* verbatim contents */ }
    // ... keyed by repo-relative path, sorted
  }
}
```

## Rules

**It is generated — never hand-edit it.** `npm run build:bundle`, or let CI do
it (`update-dataset.yml` runs it after `update:dataset` and stages it in the
same commit as the sources). A bundle committed a run behind its sources is
stale data that looks fresh.

**It contains no timestamp, and must not gain one.** Determinism is what keeps
this out of git history: CI commits only when `git status` is dirty, so an
unchanged dataset produces a byte-identical bundle and no commit. Embed a
timestamp and the repo grows by ~2.6 MB every night forever. Consumers needing a
version should use the repo's head commit SHA — free to fetch, and the real
identity of the data:

```
curl -H "Accept: application/vnd.github.sha" \
  https://api.github.com/repos/1delta-DAO/lender-metadata/commits/main
```

(That endpoint is rate-limited to 60/hour per IP unauthenticated, and a
conditional request returning 304 **still consumes quota** — measured, contrary
to GitHub's docs. Poll it from a cron, not from a request path, and fail safe.)

**It is scoped, not a dump.** `data/` holds ~13 MB; most of it no consumer
fetches (`lender-labels.json` alone is 2.5 MB, the `*-oracles-classified.json`
set ~5 MB). `manifest.json` lists exactly the paths that go in.

## manifest.json is a cross-repo contract

It mirrors the URL list in `@1delta/initializer-sdk`. **Adding a file the SDK
reads without adding it here makes the bundle silently incomplete** — and a
lender missing from the registry looks exactly like a lender with no markets.

Two guards, and only the second one is real:

1. `build-bundle.ts` fails if a manifest path is absent from the tree, unless
   it is listed in `optional` (`config/curvance.json` and
   `config/resupply.json` are — those lenders ship without published config).
2. **The consumer must fall back** to fetching any path the bundle does not
   carry. That is what turns drift into a slower read instead of missing data,
   and it is the guard that has to exist in `initializer-sdk`.
