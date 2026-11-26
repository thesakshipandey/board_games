"""First load of the Supabase database from the Google Sheet and the files built so far.

  games             BOARDS / CARDS / DUELS tabs (sheet order kept for the nightly mirror)
  bgg               BoardGameGeek data fetched with the app token (bgg/things.json)
  offers            every BGFinder listing (fetched fresh, falls back to a saved copy)
  extras, fakes     data/extras.json, data/counterfeit_list.json
  stores            GUIDE tab stores + counterfeit sellers
  user_games_import the owner's shelf (status, buy list, OWNED tab), claimed when the owner signs up

Usage: python3 -I tools/seed_supabase.py /path/to/supabase.env /path/to/workdir [--force]
workdir holds bgg/BOARDS.csv, bgg/CARDS.csv, bgg/DUELS.csv, bgg/OWNED.csv, bgg/things.json, bgf2.json
"""
import csv, datetime, json, pathlib, re, sys, urllib.request, urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from supabase_setup import load_env  # noqa: E402

TABS = {'BOARDS': 'Boards', 'CARDS': 'Cards', 'DUELS': 'Duels'}
STORES = [
    ('Board Games India', 'https://www.boardgamesindia.com/', 'https://www.boardgamesindia.com/search?q={q}'),
    ('The Board Room', 'https://shop.theboardroomindia.com/', 'https://shop.theboardroomindia.com/search-products?q={q}'),
    ('Owls On Board', 'https://www.owlsonboard.com/', 'https://www.owlsonboard.com/collections/all?q={q}'),
    ('Shuffle Games', 'https://shufflegames.co.in/', 'https://shufflegames.co.in/?s={q}&post_type=product'),
    ('Bored Game Co', 'https://boredgamecompany.com/', 'https://boredgamecompany.com/search?q={q}'),
    ('Hextasy', 'https://hextasy.in/', 'https://hextasy.in/?s={q}&post_type=product'),
    ('Big Friendly Games', 'https://bigfriendlygames.com/', 'https://bigfriendlygames.com/?s={q}&post_type=product'),
    ('Tabletop Universe', 'https://www.tabletopuniverse.com/', 'https://www.tabletopuniverse.com/search?q={q}'),
    ('Gameistry', 'https://www.gameistry.in/', 'https://www.gameistry.in/search?q={q}'),
    ('Bookswagon', 'https://www.bookswagon.com/', 'https://www.bookswagon.com/search-books/{q}'),
    ('Boardway', 'https://boardway.in/', 'https://boardway.in/search?q={q}'),
    ('Cryptic Cardboard', 'https://ccbgames.in/', 'https://ccbgames.in/index.php?route=product/search&search={q}'),
]
FAKE_STORES = [
    ('Satyams', 'https://www.satyamstationers.com/', 'https://www.satyamstationers.com/search?q={q}'),
    ('Jaiman Toys', 'https://jaimantoys.com/', 'https://jaimantoys.com/search?q={q}'),
    ('Shop Befikar', 'https://shopbefikar.com/', 'https://shopbefikar.com/search?q={q}'),
    ('Funkky', '', ''),
]


class Rest:
    def __init__(self, env):
        self.base = env['SUPABASE_URL'] + '/rest/v1/'
        key = env['SUPABASE_SERVICE_KEY']
        self.h = {'apikey': key, 'Content-Type': 'application/json', 'User-Agent': 'game-shelf-seed'}
        if key.startswith('eyJ'):
            self.h['Authorization'] = 'Bearer ' + key

    def req(self, method, path, body=None, prefer=None):
        h = dict(self.h)
        if prefer:
            h['Prefer'] = prefer
        r = urllib.request.Request(self.base + path, method=method, headers=h,
                                   data=None if body is None else json.dumps(body, ensure_ascii=False).encode())
        try:
            with urllib.request.urlopen(r, timeout=120) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raise SystemExit(f'{method} {path} -> HTTP {e.code}: {e.read().decode()[:600]}')

    def insert(self, table, rows, ret=False):
        out = []
        for i in range(0, len(rows), 500):
            got = self.req('POST', table, rows[i:i + 500], 'return=representation' if ret else 'return=minimal')
            out += got or []
        return out


def num(s, kind=int):
    s = re.sub(r'[^0-9.\-]', '', str(s or ''))
    if s in ('', '-', '.'):
        return None
    try:
        return kind(float(s)) if kind is int else round(float(s), 2)
    except ValueError:
        return None


def bgg_id(link):
    m = re.search(r'boardgame(?:expansion)?/(\d+)', link or '')
    return int(m.group(1)) if m else None


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()


def bgfinder(work):
    try:
        req = urllib.request.Request('https://www.bgfindertool.com/', headers={'User-Agent': 'Mozilla/5.0 board-game-shelf'})
        html = urllib.request.urlopen(req, timeout=60).read().decode('utf-8')
        a = html.index('id="products-data">') + len('id="products-data">')
        data = json.loads(html[a:html.index('</script>', a)])
        print('BGFinder: fresh,', len(data), 'listings')
        return data
    except Exception as e:  # noqa: BLE001
        print('BGFinder fetch failed (' + str(e)[:80] + '), using saved copy')
        return json.loads((work / 'bgf2.json').read_text())


def main():
    env = load_env(sys.argv[1])
    work = pathlib.Path(sys.argv[2])
    force = '--force' in sys.argv
    db = Rest(env)
    if db.req('GET', 'games?select=id&limit=1') and not force:
        raise SystemExit('games already has rows; pass --force to load anyway (it will add duplicates of nothing: names are unique)')

    # stores
    db.insert('stores', [{'name': n, 'url': u, 'search_url': s, 'kind': 'india', 'sort': i} for i, (n, u, s) in enumerate(STORES)]
              + [{'name': n, 'url': u or None, 'search_url': s or None, 'kind': 'counterfeit', 'sort': i} for i, (n, u, s) in enumerate(FAKE_STORES)])

    # games, in sheet order
    rows, owner = [], {}
    for tab, cat in TABS.items():
        for i, r in enumerate(list(csv.reader(open(work / 'bgg' / (tab + '.csv'), encoding='utf-8')))[1:], start=2):
            r = (r + [''] * 16)[:16]
            if not r[0].strip():
                continue
            rows.append({
                'name': r[0].strip(), 'category': cat,
                'also_in': [x.strip() for x in re.split(r'[,/]', r[15]) if x.strip() in ('Boards', 'Cards', 'Duels')],
                'min_players': num(r[1]), 'max_players': num(r[2]), 'min_time': num(r[3]), 'max_time': num(r[4]),
                'age': num(r[5]), 'weight': num(r[6], float), 'genre': r[7].strip() or None,
                'tags': [t.strip() for t in r[8].split(',') if t.strip()],
                'list_price': num(r[10]), 'buy_link': r[11].strip() or None, 'bgg_id': bgg_id(r[12]), 'sheet_row': i,
            })
            owner[r[0].strip()] = {'status': r[9].strip(), 'interest': r[13].strip(), 'since': r[14].strip()}
    games = db.insert('games', rows, ret=True)
    gid = {norm(g['name']): g['id'] for g in games}
    print('games', len(games))

    # BGG data
    things = json.loads((work / 'bgg' / 'things.json').read_text())
    want = {g['bgg_id'] for g in rows if g['bgg_id']}
    bgg_rows = []
    for k, b in things.items():
        if int(k) not in want:
            continue
        rank = b.get('rank') or ''
        bgg_rows.append({
            'bgg_id': int(k), 'name': b['name'], 'year': num(b['year']), 'image': b['image'] or None, 'thumb': b['thumb'] or None,
            'rating': num(b['rating'], float) or None, 'rank': int(rank) if rank.isdigit() else None,
            'weight': num(b['weight'], float) or None, 'best_players': b.get('bestPlayers') or None,
            'mechanics': b['mechanics'], 'categories': b['categories'], 'designers': b['designers'],
            'description': b['description'] or None, 'source': 'bgg'})
    db.insert('bgg', bgg_rows)
    print('bgg', len(bgg_rows))

    # BGFinder offers (all of them)
    offers = [{'bgg_id': int(x['bggId']), 'bgf_name': x.get('NamePrimary') or None, 'store': x.get('store'), 'listing': x.get('name'),
               'price': num(x.get('priceValue')), 'status': x.get('status'), 'url': x.get('url')}
              for x in bgfinder(work) if str(x.get('bggId') or '').strip() and not x.get('Ignore')]
    db.insert('offers', offers)
    print('offers', len(offers))

    # extras + fakes
    ex, miss = [], set()
    for i, r in enumerate(json.loads((ROOT / 'data' / 'extras.json').read_text())[1:]):
        g = gid.get(norm(r[0]))
        if not g:
            miss.add(r[0]); continue
        ex.append({'game_id': g, 'type': r[1], 'name': r[2], 'bgg_link': r[3] or None, 'price': num(r[4]), 'store': r[5] or None,
                   'buy_link': r[6] or None, 'note': r[7] or None, 'sort': i})
    db.insert('extras', ex)
    fk = []
    for r in json.loads((ROOT / 'data' / 'counterfeit_list.json').read_text())[1:]:
        g = gid.get(norm(r[0]))
        if not g:
            miss.add(r[0]); continue
        fk.append({'game_id': g, 'store': r[1], 'listing': r[2], 'price': num(r[3]), 'status': r[4] or None,
                   'url': r[5] or None, 'note': r[6] or None, 'source': 'list'})
    db.insert('fakes', fk)
    print('extras', len(ex), '| fakes', len(fk), '| unmatched base names:', sorted(miss) or 'none')

    # owner's shelf -> claimed at sign-up
    owned = {}
    for r in list(csv.reader(open(work / 'bgg' / 'OWNED.csv', encoding='utf-8')))[1:]:
        r = (r + [''] * 12)[:12]
        if r[0].strip():
            owned[r[0].strip()] = r
    email = env['ADMIN_EMAILS'].split(',')[0].strip().lower()
    imp = []
    for name, o in owner.items():
        st = o['status'] if o['status'] in ('Owned', 'On the way', 'DIY') else None
        interest = o['interest'] if o['interest'] in ('Really want', 'Normal', 'Maybe') else None
        ow = owned.get(name)
        if st is None and interest:
            st = 'Wishlist'
        if st is None and not ow:
            continue
        since = None
        if o['since']:
            for fmt in ('%d/%m/%Y %H:%M:%S', '%d/%m/%Y', '%Y-%m-%d'):
                try:
                    since = datetime.datetime.strptime(o['since'], fmt).isoformat(); break
                except ValueError:
                    pass
        auth = ow[2].strip() if ow and ow[2].strip() in ('VERIFIED ORIGINAL', 'SUSPECTED COUNTERFEIT', 'UNKNOWN') else None
        imp.append({'email': email, 'game_name': name, 'status': st, 'interest': interest, 'interest_since': since,
                    'authenticity': auth, 'price_paid': num(ow[3]) if ow else None,
                    'rating': num(ow[4], float) if ow else None, 'plays': num(ow[5]) if ow else None,
                    'notes': None, 'edition': (ow[11].strip() or None) if ow else None})
    db.req('DELETE', 'user_games_import?email=eq.' + urllib.request.quote(email))
    db.insert('user_games_import', imp)
    print('owner shelf rows waiting for', email + ':', len(imp))


if __name__ == '__main__':
    main()
