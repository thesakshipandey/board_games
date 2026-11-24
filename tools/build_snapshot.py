"""Build data/snapshot.json: a PUBLIC fallback catalogue for the website.

The live site reads from the Apps Script API. This snapshot is only used when the API
is not configured or not reachable. It deliberately leaves out STATUS, INTEREST, OWNED
and every other personal field.

Usage:  python3 -I tools/build_snapshot.py  [path/to/ALL.csv]  [path/to/bgfinder.html]
With no arguments it downloads both (the sheet must be link-readable for that).
"""
import csv, io, json, re, sys, urllib.request, datetime, pathlib

SHEET = "1bVzKKQcmN8jfEko9kLpyU68IGIFu5IYuD-vKCl3TtDc"
UA = {"User-Agent": "Mozilla/5.0 board-game-shelf"}
ROOT = pathlib.Path(__file__).resolve().parent.parent


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode("utf-8")


def num(s):
    s = re.sub(r"[^0-9.\-]", "", str(s or ""))
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def sheet_csv(tab):
    return get(f"https://docs.google.com/spreadsheets/d/{SHEET}/gviz/tq?tqx=out:csv&sheet={tab}")


def main():
    all_csv = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else sheet_csv("ALL")
    bgf_html = open(sys.argv[2], encoding="utf-8").read() if len(sys.argv) > 2 else get("https://www.bgfindertool.com/")

    a = bgf_html.index('id="products-data">') + len('id="products-data">')
    listings = json.loads(bgf_html[a:bgf_html.index("</script>", a)])
    by_id = {}
    for x in listings:
        if x.get("bggId") and not x.get("Ignore"):
            by_id.setdefault(str(x["bggId"]), []).append(x)

    games = []
    for r in csv.DictReader(io.StringIO(all_csv)):
        name = (r.get("GAME") or "").strip()
        if not name:
            continue
        m = re.search(r"boardgame(?:expansion)?/(\d+)", r.get("BGG LINK") or "")
        bid = m.group(1) if m else ""
        offers = sorted(
            ({"listing": o["name"], "store": o["store"], "price": o.get("priceValue"), "status": o.get("status"), "url": o["url"]}
             for o in by_id.get(bid, [])),
            key=lambda o: o["price"] or 1e9)
        meta = by_id.get(bid, [{}])[0]
        games.append({
            "name": name, "category": r.get("CATEGORY", "Boards"), "alsoIn": [],
            "minP": num(r.get("MIN PLAYERS")), "maxP": num(r.get("MAX PLAYERS")),
            "minT": num(r.get("MIN TIME")), "maxT": num(r.get("MAX TIME")), "age": num(r.get("AGE")),
            "weight": num(r.get("BGG WEIGHT")), "genre": r.get("GENRE", ""),
            "tags": [t.strip() for t in (r.get("TAGS") or "").split(",") if t.strip()],
            "price": num(r.get("PRICE ₹")), "buyLink": r.get("BUY LINK", ""), "bggLink": r.get("BGG LINK", ""),
            "bggId": bid, "year": num(meta.get("yearPublishedValue")), "image": meta.get("Image", ""),
            "thumb": meta.get("Thumbnail", ""), "bggRating": round(meta["bggRating"], 2) if meta.get("bggRating") else None,
            "bggRank": int(meta["bggRank"]) if meta.get("bggRank") else None,
            "mechanics": meta.get("mechanicsList", []), "bggCategories": meta.get("categoriesList", []),
            "designers": meta.get("designersList", []), "bestPlayers": "",
            "description": (meta.get("Description") or "")[:700], "offers": offers,
        })

    stores = [
        ["Board Games India", "https://www.boardgamesindia.com/"], ["The Board Room", "https://shop.theboardroomindia.com/"],
        ["Owls On Board", "https://www.owlsonboard.com/"], ["Shuffle Games", "https://shufflegames.co.in/"],
        ["Bored Game Co", "https://boredgamecompany.com/"], ["Hextasy", "https://hextasy.in/"],
        ["Big Friendly Games", "https://bigfriendlygames.com/"], ["Tabletop Universe", "https://www.tabletopuniverse.com/"],
        ["Gameistry", "https://www.gameistry.in/"], ["Bookswagon", "https://www.bookswagon.com/"],
        ["Boardway", "https://boardway.in/"], ["Cryptic Cardboard", "https://ccbgames.in/"],
    ]
    out = {
        "games": games,
        "stores": [{"name": n, "url": u} for n, u in stores],
        "counterfeit": [
            {"name": "Satyams", "url": "https://www.satyamstationers.com/", "search": "https://www.satyamstationers.com/search?q={q}"},
            {"name": "Jaiman Toys", "url": "https://jaimantoys.com/", "search": "https://jaimantoys.com/search?q={q}"},
            {"name": "Shop Befikar", "url": "https://shopbefikar.com/", "search": "https://shopbefikar.com/search?q={q}"},
        ],
        "genres": [],
        "bgfUpdated": datetime.date.today().isoformat(),
        "built": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "snapshot": True,
    }
    dest = ROOT / "data" / "snapshot.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_art = sum(1 for g in games if g["image"])
    with_offers = sum(1 for g in games if g["offers"])
    print(f"{len(games)} games, {with_art} with art, {with_offers} with live India offers -> {dest}")


if __name__ == "__main__":
    main()
