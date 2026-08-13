#!/usr/bin/env bash
# Deploy snack approval to Quick.
#
#   ./deploy.sh staging   -> <site>-staging on the Quick host
#   ./deploy.sh prod      -> <site>, the baseUrl in snack.config.json
#
# `quick deploy` uploads the whole directory it is given, so we assemble a
# clean bundle first. Without this, .git/ and .old-v2/ would ship too.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f snack.config.json ]; then
  echo "error: snack.config.json is missing." >&2
  echo "       cp snack.config.example.json snack.config.json  and fill it in." >&2
  exit 1
fi
BASESITE=$(python3 -c 'import json;print(json.load(open("snack.config.json"))["site"])')

TARGET="${1:-}"
case "$TARGET" in
  staging) SITE="${BASESITE}-staging" ;;
  prod)    SITE="$BASESITE" ;;
  *) echo "usage: ./deploy.sh {staging|prod}" >&2; exit 2 ;;
esac

BUILD="$(mktemp -d)/snack-approval"
mkdir -p "$BUILD"
cp -R css js favicon.svg "$BUILD"/
cp index.html feed.html board.html stats.html judge.html settings.html review.html "$BUILD"/

# The approver's identity is not in git, and the site needs it at runtime.
cp snack.config.json "$BUILD"/

echo "Deploying $(find "$BUILD" -type f | wc -l | tr -d ' ') files to ${SITE}"
quick deploy --force "$BUILD" "$SITE"
echo "Done: ${SITE} deployed"
