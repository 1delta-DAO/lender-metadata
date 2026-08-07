#!/usr/bin/env bash
set -euo pipefail

# update-1delta.sh — bump every @1delta/* package across this repo to its
# latest published version, then `pnpm install` in each workspace that
# changed. Mirrors the manual workflow we ran for months.
#
# Usage:
#   ./update-1delta.sh             # update to latest, install, typecheck
#   ./update-1delta.sh --check     # report drift only; exit non-zero if any
#   ./update-1delta.sh --dry-run   # show planned changes, write nothing
#   ./update-1delta.sh --no-build  # skip the post-install `pnpm build`
#   ./update-1delta.sh --allow-major  # permit MAJOR-version jumps (see below)
#
# Notes
# - Walks every package.json under the repo (excluding node_modules) that
#   references "@1delta/" — so both deps AND pnpm.overrides get bumped in
#   lockstep. Mismatched overrides make `pnpm install` error, so we always
#   update them together via a single in-place sed.
# - Uses `npm view <pkg> version` for the registry lookup. No jq dependency.
# - Pin format `^X.Y.Z` is preserved (caret on 0.0.x is effectively a pin
#   under semver, so the caret prefix doesn't risk silent drift).
# - The `--no-build` escape hatch is for the rare case the new package
#   genuinely breaks the build and you want to keep the lockfile change
#   while you fix the call sites.
# - MAJOR jumps are REFUSED by default. Our registry history is not always
#   clean — `@1delta/margin-fetcher` runs 0.0.409 -> 0.0.2889 -> 0.0.3423 ->
#   5.0.0, so `latest` can cross a major boundary (or land on a different
#   release track entirely) without anyone intending it. Silently rewriting a
#   pin across that line is how a repo ends up on a package it was never
#   tested against. Re-run with `--allow-major` once you have decided the
#   jump is real.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DRY=0
CHECK=0
DO_BUILD=1
ALLOW_MAJOR=0
SKIPPED_MAJOR=()
for arg in "${@:-}"; do
  case "$arg" in
    ""|--) ;;
    --dry-run) DRY=1 ;;
    --check)   CHECK=1; DRY=1 ;;
    --no-build) DO_BUILD=0 ;;
    --allow-major) ALLOW_MAJOR=1 ;;
    -h|--help)
      sed -n '3,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── 1. Find every package.json that references @1delta/ ─────────────────
mapfile -t PKG_FILES < <(
  grep -rl --include=package.json '@1delta/' . 2>/dev/null \
  | grep -v '/node_modules/' \
  | sort
)

if [[ ${#PKG_FILES[@]} -eq 0 ]]; then
  echo "no package.json files reference @1delta/*"
  exit 0
fi

# Collect unique @1delta/* package names referenced anywhere.
mapfile -t PKGS < <(
  grep -h -oE '"@1delta/[a-z0-9-]+"' "${PKG_FILES[@]}" \
  | sort -u | tr -d '"'
)

echo "Found ${#PKGS[@]} @1delta package(s) across ${#PKG_FILES[@]} package.json file(s)"

# ── 2. Resolve latest versions in parallel ──────────────────────────────
declare -A LATEST
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
for pkg in "${PKGS[@]}"; do
  safe=${pkg//\//__}
  (npm view "$pkg" version 2>/dev/null > "$TMPDIR/$safe" || true) &
done
wait
for pkg in "${PKGS[@]}"; do
  safe=${pkg//\//__}
  v=$(cat "$TMPDIR/$safe" 2>/dev/null | tr -d '[:space:]')
  if [[ -z "$v" ]]; then
    echo "  ! could not resolve latest for $pkg — skipping" >&2
    continue
  fi
  LATEST[$pkg]="$v"
done

# ── 3. Update every (pkg, file) pair where the pinned version drifts ───
CHANGED_DIRS=()
ANY_DRIFT=0
for f in "${PKG_FILES[@]}"; do
  workspace_dir=$(dirname "$f")
  changed_this_file=0
  for pkg in "${!LATEST[@]}"; do
    latest=${LATEST[$pkg]}
    # Find every distinct currently-pinned version of this package in this
    # file. There can be more than one (dep + overrides) but they SHOULD
    # be identical — if they aren't, we bump all of them to `latest`.
    mapfile -t currents < <(
      grep -oE "\"$pkg\": *\"\\^?[0-9.]+\"" "$f" \
      | sed -E 's/.*"\^?([0-9.]+)"$/\1/' \
      | sort -u
    )
    [[ ${#currents[@]} -eq 0 ]] && continue
    for cur in "${currents[@]}"; do
      if [[ "$cur" == "$latest" ]]; then continue; fi
      # Refuse to cross a major boundary unless explicitly allowed.
      cur_major=${cur%%.*}
      latest_major=${latest%%.*}
      if [[ $ALLOW_MAJOR -eq 0 && "$cur_major" != "$latest_major" ]]; then
        echo "  ${f#./}: $pkg $cur -> $latest  [SKIPPED: major bump — re-run with --allow-major]"
        SKIPPED_MAJOR+=("$pkg $cur -> $latest")
        continue
      fi
      ANY_DRIFT=1
      echo "  ${f#./}: $pkg $cur -> $latest"
      if [[ $DRY -eq 0 ]]; then
        # Escape dots in `cur` so the sed pattern is literal. The package
        # name has a slash, which is fine inside an alternative delimiter.
        cur_esc=${cur//./\\.}
        sed -i "s|\"$pkg\": \"\\^$cur_esc\"|\"$pkg\": \"^$latest\"|g" "$f"
        changed_this_file=1
      fi
    done
  done
  if [[ $changed_this_file -eq 1 ]]; then
    CHANGED_DIRS+=("$workspace_dir")
  fi
done

if [[ ${#SKIPPED_MAJOR[@]} -gt 0 ]]; then
  echo
  echo "major-version jumps NOT applied (${#SKIPPED_MAJOR[@]}):"
  printf '  %s\n' "${SKIPPED_MAJOR[@]}"
fi

if [[ $CHECK -eq 1 ]]; then
  if [[ $ANY_DRIFT -eq 1 ]]; then
    echo "drift detected"
    exit 1
  fi
  echo "all @1delta/* packages already at latest"
  exit 0
fi

if [[ ${#CHANGED_DIRS[@]} -eq 0 ]]; then
  echo "all @1delta/* packages already at latest"
  exit 0
fi

if [[ $DRY -eq 1 ]]; then
  echo "(dry run — no files written)"
  exit 0
fi

# ── 4. `pnpm install` in each affected workspace ────────────────────────
mapfile -t UNIQUE_DIRS < <(printf '%s\n' "${CHANGED_DIRS[@]}" | sort -u)
for d in "${UNIQUE_DIRS[@]}"; do
  echo
  echo "== pnpm install in $d =="
  (cd "$d" && pnpm install)
done

# ── 5. Optional typecheck so the bump fails loudly on a breaking SDK ───
if [[ $DO_BUILD -eq 1 ]]; then
  for d in "${UNIQUE_DIRS[@]}"; do
    # Only run if the workspace has a `build` script — keeps the script
    # generic across repos where some package.json files are leaf libs.
    if (cd "$d" && node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)" 2>/dev/null); then
      echo
      echo "== pnpm build in $d =="
      (cd "$d" && pnpm build)
    fi
  done
fi

echo
echo "done. Updated workspaces:"
printf '  %s\n' "${UNIQUE_DIRS[@]}"
