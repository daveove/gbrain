#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Produce a package-only commit, without installation or credential access.
# Publishing is an explicit separate invocation and only targets this fork.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Commit reviewed changes before splitting the package.' >&2
  exit 1
fi
PACKAGE_COMMIT="$(git subtree split --prefix=packages/evidence-context HEAD)"
printf 'Package commit: %s\n' "$PACKAGE_COMMIT"
printf 'Dependency: https://codeload.github.com/daveove/gbrain/tar.gz/%s\n' "$PACKAGE_COMMIT"
if [[ "${1:-}" == '--push' ]]; then
  PACKAGE_REMOTE="$(git remote get-url origin)"
  case "$PACKAGE_REMOTE" in
    https://github.com/daveove/gbrain.git|git@github.com:daveove/gbrain.git) ;;
    *) echo 'Package publication requires the owned daveove/gbrain destination.' >&2; exit 1 ;;
  esac
  git push origin "$PACKAGE_COMMIT:refs/heads/packages/evidence-context-$PACKAGE_COMMIT"
fi
