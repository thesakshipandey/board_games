"""data/snapshot.json: the public fallback catalogue the site uses if the database can't be reached.

Same shape as the database's catalog() function. No personal data.

  python3 -I tools/build_snapshot.py --live <supabase.env>      dump the live catalogue (normal use)
  python3 -I tools/build_snapshot.py --local <workdir>          build from the sheet CSVs + BGG/BGFinder files
"""
import csv, datetime, json, pathlib, re, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))


def live(env_path):
    from supabase_setup import load_env
    env = load_env(env_path)
    key = env['SUPABASE_ANON_KEY']
    req = urllib.request.Request(env['SUPABASE_URL'] + '/rest/v1/rpc/catalog', method='POST', data=b'{}',
                                 headers={'apikey': key, 'Content-Type': 'application/json'})
    if key.startswith('eyJ'):
        req.add_header('Authorization', 'Bearer ' + key)
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def local(work):
    from seed_supabase import STORES, FAKE_STORES, TABS, num, bgg_id, norm
    work = pathlib.Path(work)
    things = json.loads((work / 'bgg' / 'things.json').read_text())
    offers = {}
    for x in json.loads((work / 'bgf2.json').read_text()):
        if str(x.get('bggId') or '').strip() and not x.get('Ignore'):
            offers.setdefault(int(x['bggId']), []).append({'listing': x['name'], 'store': x['store'], 'price': num(x.get('priceValue')), 'status': x.get('status'), 'url': x['url']})
    extras, fakes = {}, {}
    for r in json.loads((ROOT / 'data' / 'extras.json').read_text())[1:]:
        extras.setdefault(norm(r[0]), []).append({'type': r[1], 'name': r[2], 'bgg': r[3] or None, 'price': num(r[4]), 'store': r[5] or None, 'buy': r[6] or None, 'note': r[7] or None})
    for r in json.loads((ROOT / 'data' / 'counterfeit_list.json').read_text())[1:]:
        fakes.setdefault(norm(r[0]), []).append({'store': r[1], 'listing': r[2], 'price': num(r[3]), 'status': r[4] or None, 'url': r[5] or None, 'note': r[6] or None})
    games, gid = [], 0
    for tab, cat in TABS.items():
        for r in list(csv.reader(open(work / 'bgg' / (tab + '.csv'), encoding='utf-8')))[1:]:
            r = (r + [''] * 16)[:16]
            if not r[0].strip():
                continue
            gid += 1
            bid = bgg_id(r[12])
            b = things.get(str(bid), {}) if bid else {}
            d = b.get('description') or ''
            cut = len(d) > 900
            games.append({
                'id': gid, 'name': r[0].strip(), 'category': cat,
                'alsoIn': [x.strip() for x in re.split(r'[,/]', r[15]) if x.strip() in ('Boards', 'Cards', 'Duels')],
                'minP': num(r[1]), 'maxP': num(r[2]), 'minT': num(r[3]), 'maxT': num(r[4]), 'age': num(r[5]),
                'weight': num(r[6], float), 'genre': r[7].strip() or None, 'tags': [t.strip() for t in r[8].split(',') if t.strip()],
                'price': num(r[10]), 'buyLink': r[11].strip() or None, 'bggId': bid,
                'bggLink': f'https://boardgamegeek.com/boardgame/{bid}' if bid else None,
                'year': num(b.get('year')), 'image': b.get('image') or None, 'thumb': b.get('thumb') or None,
                'bggRating': num(b.get('rating'), float), 'bggRank': int(b['rank']) if str(b.get('rank', '')).isdigit() else None,
                'bestPlayers': b.get('bestPlayers') or None, 'mechanics': b.get('mechanics', []), 'bggCategories': b.get('categories', []),
                'designers': b.get('designers', []), 'description': re.sub(r'[\s,;:.]+\S*$', '', d[:900]) if cut else (d or None),
                'descriptionCut': cut, 'offers': sorted(offers.get(bid, []), key=lambda o: o['price'] or 1e9),
                'extras': extras.get(norm(r[0]), []), 'fakes': fakes.get(norm(r[0]), []),
            })
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return {'games': sorted(games, key=lambda g: g['name'].lower()),
            'stores': [{'name': n, 'url': u, 'search': s} for n, u, s in STORES],
            'counterfeit': [{'name': n, 'url': u or None, 'search': s or None} for n, u, s in FAKE_STORES],
            'pricesUpdated': now, 'bggUpdated': now, 'built': now}


def main():
    mode, arg = sys.argv[1], sys.argv[2]
    out = live(arg) if mode == '--live' else local(arg)
    out['snapshot'] = True
    dest = ROOT / 'data' / 'snapshot.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"{len(out['games'])} games -> {dest} ({dest.stat().st_size // 1024} KB)")


if __name__ == '__main__':
    main()
