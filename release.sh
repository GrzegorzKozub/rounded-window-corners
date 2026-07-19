#!/usr/bin/env bash
set -eo pipefail -u

TAG="v$(date +%Y%m%d).$(git rev-parse --short=7 HEAD)"

git tag "$TAG"
git push origin "$TAG"

echo "$TAG"
