# The Game Shelf

A board game website built on your Google Sheet.

- **Home page:** a search bar, a **player count** box, Boards / Cards / Duels chips and **type tags** (Cooperative, Strategy, Tile Placement, Party, Engine Building, Deck Building, Trick Taking, War Game, Economic…), above a live **summary**.
- **Every game** shows BGG info (art, rank, rating, weight, mechanics, best player count), **live Indian store prices from BGFinder**, search links for all 12 Indian stores, and a separate **counterfeit / budget** section (Satyams, Jaiman Toys, Shop Befikar).
- **Categories overlap:** a game can be in more than one. Any 2-player-max game also counts as a Duel, any BGG "Card Game" also counts as Cards, and the optional **ALSO IN** column in BOARDS/CARDS/DUELS adds more.
- **Public visitors** can search and browse. They never see what you own, your prices or your ratings.
- **Anyone who signs in with Google** gets their own private shelf: status, buy interest, authenticity, price paid, rating /10, times played and notes. Their owned games turn **green** in every search.
- **Only you** can add games. Search BGG, pick a result, and the row (with the cheapest in-stock Indian price and link) goes into BOARDS / CARDS / DUELS. Your status and ratings are written straight into your sheet (STATUS, INTEREST, OWNED), so BUY LIST and SUMMARY keep working.

```
GitHub Pages (this folder)  ──►  Apps Script web app (runs as you)  ──►  your Google Sheet
     static HTML/JS              verifies Google sign-in, admin check      BOARDS/CARDS/DUELS, OWNED,
                                 BGG API + BGFinder nightly refresh        + BGG_CACHE, BGFINDER_PRICES,
                                                                           USER_DATA, COUNTERFEIT tabs
```

Until the backend is set up, the site runs read-only from `data/snapshot.json`.

## One-time setup (about 15 minutes)

### 1. Make the sheet private
The web app reads the sheet **as you**, so nobody else needs access. Open the sheet, click **Share**, and set General access to **Restricted**. At the moment anyone with the link can read STATUS and OWNED.

### 2. Google sign-in client ID
1. Go to <https://console.cloud.google.com/apis/credentials> and create a project if asked.
2. If it asks, set up the **OAuth consent screen**: External, app name "The Game Shelf", your email. Publish it (the only scopes are basic profile and email, so no review is needed).
3. Click **Create credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins**, add `https://thesakshipandey.github.io` (and `http://localhost:8765` for local testing).
5. Copy the client ID (`…apps.googleusercontent.com`).

### 3. Backend (Apps Script)
1. Go to <https://script.google.com>, click **New project** and name it "Game Shelf API". It must be a **standalone** project, not Extensions → Apps Script inside the sheet, so it can't clash with your existing v4 script.
2. Replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Open **Project Settings → Script properties** and add:
   - `GOOGLE_CLIENT_ID`: the client ID from step 2 (required)
   - `ADMIN_EMAILS`: optional. It defaults to you, the script owner. Add others with commas.
   - `BGG_TOKEN`: optional but recommended. Register an app at <https://boardgamegeek.com/applications> to get one. Without it, BGG data comes only from BGFinder, which covers games sold in India.
4. Choose `setup` in the function dropdown and click **Run**, then approve the permissions. This adds the ALSO IN column and the helper tabs, pulls BGFinder prices, fills BGG art and ratings, and schedules a nightly refresh at 4 am.
5. **Deploy → New deployment → Web app**. Set Execute as **Me** and Who has access **Anyone**, then copy the `/exec` URL.

### 4. Point the site at it
Put both values in `config.js`:
```js
API_URL: 'https://script.google.com/macros/s/…/exec',
GOOGLE_CLIENT_ID: '…apps.googleusercontent.com',
```
Then run `./tools/deploy.sh`. It copies the site into `thesakshipandey.github.io/boardgame/` and pushes, and GitHub publishes it at **https://thesakshipandey.github.io/boardgame/**.

> After changing `Code.gs`, go to **Deploy → Manage deployments → Edit → Version: New version**. Otherwise the URL keeps serving the old code.

## Day to day
- **Adding a game:** sign in, open **＋ Add game**, search, pick a result, adjust the form and save. Pasting a BGG link or id also works.
- **Editing in the sheet** still works. The site picks changes up within about 10 minutes (the catalogue cache).
- **Status changes made on the site** go into STATUS / INTEREST / OWNED directly. Edits made by a script don't trigger your sheet's onEdit, so if BUY LIST or OWNED looks stale, use **Board Games → Sync OWNED now** in the sheet.
- **Counterfeit sellers** live in the **COUNTERFEIT** tab (name, website, search URL with `{q}`). Edit it freely.
- **Indian stores** come from GUIDE → STORES.

## Files
| Path | What |
|---|---|
| `index.html`, `assets/` | the site |
| `config.js` | API URL + Google client ID (both are public values) |
| `data/snapshot.json` | public fallback catalogue, built by `python3 -I tools/build_snapshot.py` |
| `apps-script/Code.gs` | backend |
| `tools/deploy.sh` | copies the site to the GitHub Pages repo and pushes |

Game data **Powered by BGG**. India prices via [BGFinder](https://www.bgfindertool.com/).
