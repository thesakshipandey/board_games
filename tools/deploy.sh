#!/usr/bin/env bash
# Copy the site into the GitHub Pages repo at /boardgame and push it live.
# Each deploy stamps the asset URLs with a fresh version (?v=...) so browsers never mix
# an old script with a new page.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SITE="${SITE_REPO:-$HERE/../thesakshipandey.github.io}"
DEST="$SITE/boardgame"
VERSION="$(date +%Y%m%d%H%M%S)"
mkdir -p "$DEST"
rsync -a --delete --exclude '.DS_Store' \
  "$HERE/index.html" "$HERE/config.js" "$HERE/assets" "$HERE/data" "$DEST/"
sed -i '' "s/?v=dev/?v=$VERSION/g" "$DEST/index.html"
cd "$SITE"
git add boardgame
if git diff --cached --quiet; then echo "Nothing changed."; exit 0; fi
git commit -m "${COMMIT_MSG:-Update board game shelf}"
git push
echo "Pushed version $VERSION. Live in a few minutes at https://thesakshipandey.github.io/boardgame/"
