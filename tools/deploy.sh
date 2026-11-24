#!/usr/bin/env bash
# Copy the site into the GitHub Pages repo at /boardgame and push it live.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SITE="${SITE_REPO:-$HERE/../thesakshipandey.github.io}"
DEST="$SITE/boardgame"
mkdir -p "$DEST"
rsync -a --delete --exclude '.DS_Store' \
  "$HERE/index.html" "$HERE/config.js" "$HERE/assets" "$HERE/data" "$DEST/"
cd "$SITE"
git add boardgame
if git diff --cached --quiet; then echo "Nothing changed."; exit 0; fi
git commit -m "Update board game shelf"
git push
echo "Pushed. Live in a few minutes at https://thesakshipandey.github.io/boardgame/"
