#!/bin/sh
# Refresh docker/runtime/python/visionlens from the canonical python/visionlens.
#
# BuildKit does not follow a symlink out of the build context, so the wheel
# source is vendored here as real files and the image builds from this copy.
# Run this after editing python/visionlens, then rebuild the image. Only what
# the wheel needs is copied: pyproject.toml, README.md and src/. Tests, dist
# and caches stay out so the build context stays minimal.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/../../python/visionlens" && pwd)
dst="$here/python/visionlens"

if [ ! -f "$src/pyproject.toml" ]; then
    echo "sync-visionlens: missing $src/pyproject.toml" >&2
    exit 1
fi

rm -rf "$dst"
mkdir -p "$dst"
cp "$src/pyproject.toml" "$src/README.md" "$dst"
cp -R "$src/src" "$dst/src"
find "$dst" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$dst" -name .pytest_cache -type d -prune -exec rm -rf {} +
find "$dst" -name '*.pyc' -delete
echo "synced $dst from $src (wheel source only)"
