"""Box art: downloads each game's original BoardGameGeek image once and saves a sharp, light copy.

BGG only offers a tiny 200px thumbnail (blurry on cards) or the full original (often 300 KB to 3 MB).
This keeps a 640px WebP per game (about 40 KB) next to the site, plus art/index.json listing them.
Images already saved are never downloaded again.

Usage:
  python3 -I tools/build_art.py <site-folder> --catalog-url URL --anon-key KEY   (reads the live catalogue)
  python3 -I tools/build_art.py <site-folder> --things path/to/things.json         (first run, offline list)
"""
import argparse, io, json, pathlib, sys, time, urllib.request

from PIL import Image

MAX = 640


def items_from_catalog(url, key):
    req = urllib.request.Request(url, method='POST', data=b'{}', headers={'apikey': key, 'Content-Type': 'application/json'})
    if key.startswith('eyJ'):
        req.add_header('Authorization', 'Bearer ' + key)
    cat = json.loads(urllib.request.urlopen(req, timeout=60).read())
    return {str(g['bggId']): g['image'] for g in cat['games'] if g.get('bggId') and g.get('image')}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('site')
    ap.add_argument('--catalog-url')
    ap.add_argument('--anon-key')
    ap.add_argument('--things')
    a = ap.parse_args()
    out = pathlib.Path(a.site) / 'art'
    out.mkdir(parents=True, exist_ok=True)
    if a.things:
        items = {k: v['image'] for k, v in json.loads(pathlib.Path(a.things).read_text()).items() if v.get('image')}
    else:
        items = items_from_catalog(a.catalog_url, a.anon_key)
    have = {p.stem for p in out.glob('*.webp')}
    todo = [(k, u) for k, u in items.items() if k not in have]
    print(f'{len(items)} games with art, {len(have)} already saved, {len(todo)} to fetch', flush=True)
    done = failed = 0
    for k, u in todo:
        try:
            req = urllib.request.Request(u, headers={'User-Agent': 'board-game-shelf (box art cache)'})
            raw = urllib.request.urlopen(req, timeout=60).read()
            im = Image.open(io.BytesIO(raw))
            im = im.convert('RGBA') if im.mode in ('P', 'LA', 'RGBA') or 'transparency' in im.info else im.convert('RGB')
            im.thumbnail((MAX, MAX), Image.LANCZOS)
            im.save(out / f'{k}.webp', 'WEBP', quality=82, method=6)
            done += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print('  skip', k, str(e)[:80], flush=True)
        time.sleep(0.25)   # gentle on BGG's image CDN
    ids = sorted(int(p.stem) for p in out.glob('*.webp'))
    (out / 'index.json').write_text(json.dumps(ids, separators=(',', ':')))
    print(f'saved {done}, failed {failed}, total {len(ids)}')
    return 0 if failed < max(5, len(todo) // 5) else 1


if __name__ == '__main__':
    sys.exit(main())
