#!/usr/bin/env bash
# Copy the site into the GitHub Pages repo at /boardgame and push it live.
# Each deploy stamps the asset URLs with a fresh version (?v=...) so browsers never mix
# an old script with a new page, and saves sharp box art for any game added since last time.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SITE="${SITE_REPO:-$HERE/../thesakshipandey.github.io}"
DEST="$SITE/boardgame"
VERSION="$(date +%Y%m%d%H%M%S)"
mkdir -p "$DEST"
# art/ holds the box-art copies (built below): never delete it.
rsync -a --delete --exclude '.DS_Store' --exclude 'art/' \
  "$HERE/index.html" "$HERE/config.js" "$HERE/assets" "$HERE/data" "$DEST/"
sed -i '' "s/?v=dev/?v=$VERSION/g" "$DEST/index.html"
URL=$(sed -n "s/.*SUPABASE_URL: *'\([^']*\)'.*/\1/p" "$HERE/config.js")
KEY=$(sed -n "s/.*SUPABASE_ANON_KEY: *'\([^']*\)'.*/\1/p" "$HERE/config.js")
if [ -n "$URL" ] && [ -n "$KEY" ]; then
  python3 -I "$HERE/tools/build_art.py" "$DEST" --catalog-url "$URL/rest/v1/rpc/catalog" --anon-key "$KEY" || echo "Box art step failed; the site falls back to BGG images."
fi
cd "$SITE"
git add boardgame
if git diff --cached --quiet; then echo "Nothing changed."; exit 0; fi
git commit -m "${COMMIT_MSG:-Update board game shelf}"
git push
echo "Pushed version $VERSION. Live in a few minutes at https://thesakshipandey.github.io/boardgame/"
