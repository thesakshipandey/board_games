/**
 * The Game Shelf: server jobs (Google Apps Script)
 * ------------------------------------------------
 * The website now reads and writes a Supabase database directly. This script is the part
 * that has to run on a server:
 *   - nightly: BGG data (with the app token), BGFinder prices, BGG ranks, counterfeit prices
 *   - nightly: mirrors the database back into the Google Sheet (so SUMMARY / BUY LIST keep working)
 *   - welcome email: Supabase calls this after someone signs up; it is sent from your Gmail
 *   - owner tools: BoardGameGeek search for the "Add a game" page (the BGG token stays here)
 *
 * Deploy:  Deploy > Manage deployments > Edit > New version   (Execute as: Me, Who has access: Anyone)
 * Script properties (Project Settings > Script properties):
 *   BGG_TOKEN             BoardGameGeek XML API token
 *   SUPABASE_URL          https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role / secret key (server only: never on the website)
 *   WELCOME_SECRET        same value as private.settings.welcome_secret in the database
 * Then run setup() once from the editor (it schedules the nightly job).
 */

const SHEET_ID = '1bVzKKQcmN8jfEko9kLpyU68IGIFu5IYuD-vKCl3TtDc';
const SITE = 'https://thesakshipandey.github.io/boardgame/';
const WELCOME_TEMPLATE = 'https://raw.githubusercontent.com/thesakshipandey/board_games/main/supabase/email/welcome.html';
const CAT_TABS = { BOARDS: 'Boards', CARDS: 'Cards', DUELS: 'Duels' };
const COL = { GAME: 1, MINP: 2, MAXP: 3, MINT: 4, MAXT: 5, AGE: 6, WEIGHT: 7, GENRE: 8, TAGS: 9,
  STATUS: 10, PRICE: 11, LINK: 12, BGG: 13, INTEREST: 14, SINCE: 15, ALSO: 16 };
const OWNED_TAB = 'OWNED';
const OWNED_EDITION_COL = 12;
const BGF_URL = 'https://www.bgfindertool.com/';
const RANKS_REPO = 'https://raw.githubusercontent.com/beefsack/bgg-ranking-historicals/master/';
const BGG_PAUSE_MS = 5000;   // BGG: ~5 s between requests
const BGG_BATCH = 20;        // BGG: max ids per /thing request
const BGG_STALE_DAYS = 30;

/* ------------------------------------------------------------------ HTTP */

function doGet() {
  return json_({ ok: true, service: 'game-shelf-jobs' });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  try {
    let out;
    switch (body.action) {
      case 'welcome': out = welcome_(body); break;
      case 'bggSearch': admin_(body.token); out = bggSearch_(String(body.q || '')); break;
      case 'bggDetails': admin_(body.token); out = bggDetails_(String(body.id || '')); break;
      case 'refresh': admin_(body.token); refreshBgfinder(); fillBgg(); out = { ok: true }; break;
      case 'mirror': admin_(body.token); out = { rows: mirrorSheet() }; break;
      default: throw new Error('Unknown action');
    }
    return json_({ ok: true, data: out });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { const v = props_().getProperty(k); if (!v) throw new Error('Missing script property ' + k); return String(v).trim(); }

/* ------------------------------------------------------------------ Supabase (service role, server only) */

function sb_(method, path, body, prefer) {
  const key = prop_('SUPABASE_SERVICE_KEY');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(key)) headers.Authorization = 'Bearer ' + key;
  if (prefer) headers.Prefer = prefer;
  const opt = { method: method, headers: headers, muteHttpExceptions: true };
  if (body !== undefined) opt.payload = JSON.stringify(body);
  const r = UrlFetchApp.fetch(prop_('SUPABASE_URL') + '/rest/v1/' + path, opt);
  const code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) throw new Error('Supabase ' + method + ' ' + path.split('?')[0] + ': HTTP ' + code + ' ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

function sbAll_(path) {   // pages through > 1000 rows
  const out = [];
  for (let from = 0; ; from += 1000) {
    const key = prop_('SUPABASE_SERVICE_KEY');
    const headers = { apikey: key, Range: from + '-' + (from + 999) };
    if (/^eyJ/.test(key)) headers.Authorization = 'Bearer ' + key;
    const r = UrlFetchApp.fetch(prop_('SUPABASE_URL') + '/rest/v1/' + path, { headers: headers, muteHttpExceptions: true });
    if (r.getResponseCode() >= 300) throw new Error('Supabase GET ' + path + ': ' + r.getContentText().slice(0, 200));
    const rows = JSON.parse(r.getContentText());
    out.push.apply(out, rows);
    if (rows.length < 1000) return out;
  }
}

function sbInsert_(table, rows, prefer) {
  for (let i = 0; i < rows.length; i += 500) sb_('POST', table, rows.slice(i, i + 500), prefer || 'return=minimal');
}

/** The signed-in website user behind a Supabase access token, if they are the owner. */
function admin_(token) {
  if (!token) throw new Error('Sign in first');
  const key = prop_('SUPABASE_SERVICE_KEY');
  const r = UrlFetchApp.fetch(prop_('SUPABASE_URL') + '/auth/v1/user', {
    headers: { apikey: key, Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Session expired, please sign in again');
  const user = JSON.parse(r.getContentText());
  const p = sb_('GET', 'profiles?select=is_admin&id=eq.' + user.id);
  if (!p.length || !p[0].is_admin) throw new Error('Only the owner can do this');
  return user;
}

/* ------------------------------------------------------------------ welcome email */

function welcome_(b) {
  if (!b.secret || b.secret !== prop_('WELCOME_SECRET')) throw new Error('Not allowed');
  const email = String(b.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Bad email');
  const cache = CacheService.getScriptCache();
  let tpl = cache.get('welcome_tpl');
  if (!tpl) {
    tpl = UrlFetchApp.fetch(WELCOME_TEMPLATE, { muteHttpExceptions: true }).getContentText();
    if (tpl.length < 90000) cache.put('welcome_tpl', tpl, 21600);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const name = String(b.name || email.split('@')[0]);
  const joined = b.joined ? Utilities.formatDate(new Date(b.joined), 'Asia/Kolkata', 'd MMM yyyy') : '';
  const vals = { first: name.split(' ')[0], name: name, username: b.username || '', email: email,
    provider: b.provider === 'google' ? 'Google' : 'Email and password', joined: joined };
  const html = tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => k in vals ? esc(vals[k]) : m);
  const text = 'Welcome to The Game Shelf, ' + vals.first + '!\n\nYour account is ready.\n' +
    'Display name: ' + vals.name + '\nUsername: @' + vals.username + '\nEmail: ' + email + '\nSigned up with: ' + vals.provider +
    '\nMember since: ' + joined + '\n\nOpen your shelf: ' + SITE + '#shelf\n\nMade with love by Sakshi';
  GmailApp.sendEmail(email, 'Welcome to The Game Shelf, ' + vals.first + ' 🎲', text, { htmlBody: html, name: 'The Game Shelf' });
  return { sent: true };
}

/* ------------------------------------------------------------------ BoardGameGeek */

function bggFetch_(path) {
  const token = String(props_().getProperty('BGG_TOKEN') || '').trim();
  if (!token) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = UrlFetchApp.fetch('https://boardgamegeek.com/xmlapi2/' + path, {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    const code = r.getResponseCode();
    if (code === 200) return XmlService.parse(r.getContentText()).getRootElement();
    if (code === 202 || code === 429 || code >= 500) { Utilities.sleep(BGG_PAUSE_MS * (attempt + 1)); continue; }
    if (code === 401 || code === 403) throw new Error('BGG refused the token (HTTP ' + code + '). Check the BGG_TOKEN script property.');
    return null;
  }
  return null;
}

function bggThings_(ids) {
  const root = bggFetch_('thing?stats=1&id=' + ids.join(','));
  const out = {};
  if (root) root.getChildren('item').forEach(item => { const d = bggItem_(item); out[d.id] = d; });
  return out;
}

function bggItem_(item) {
  const id = item.getAttribute('id').getValue();
  const val = (n) => { const c = item.getChild(n); return c ? c.getAttribute('value').getValue() : ''; };
  const links = (type) => item.getChildren('link').filter(l => l.getAttribute('type').getValue() === type).map(l => l.getAttribute('value').getValue());
  const primary = item.getChildren('name').find(n => n.getAttribute('type').getValue() === 'primary');
  const st = item.getChild('statistics').getChild('ratings');
  const rank = st.getChild('ranks').getChildren('rank').find(r => r.getAttribute('name').getValue() === 'boardgame');
  let best = '';
  const poll = item.getChildren('poll').find(p => p.getAttribute('name').getValue() === 'suggested_numplayers');
  if (poll) {
    let top = -1;
    poll.getChildren('results').forEach(rs => {
      const b = rs.getChildren('result').find(x => x.getAttribute('value').getValue() === 'Best');
      const votes = b ? +b.getAttribute('numvotes').getValue() : 0;
      if (votes > top) { top = votes; best = rs.getAttribute('numplayers').getValue(); }
    });
  }
  const rk = rank ? rank.getAttribute('value').getValue() : '';
  return {
    id: id, name: primary ? primary.getAttribute('value').getValue() : id,
    year: +val('yearpublished') || null, minP: +val('minplayers') || null, maxP: +val('maxplayers') || null,
    minT: +val('minplaytime') || +val('playingtime') || null, maxT: +val('maxplaytime') || +val('playingtime') || null,
    age: +val('minage') || null, weight: +(+st.getChild('averageweight').getAttribute('value').getValue()).toFixed(2) || null,
    rating: +(+st.getChild('average').getAttribute('value').getValue()).toFixed(2) || null,
    rank: /^\d+$/.test(rk) ? +rk : null,
    image: item.getChildText('image') || null, thumb: item.getChildText('thumbnail') || null,
    mechanics: links('boardgamemechanic'), categories: links('boardgamecategory'),
    designers: links('boardgamedesigner'), bestPlayers: best || null,
    description: decode_(item.getChildText('description') || '') || null
  };
}

function bggRow_(d) {
  return { bgg_id: +d.id, name: d.name, year: d.year, image: d.image, thumb: d.thumb, rating: d.rating, rank: d.rank,
    weight: d.weight, best_players: d.bestPlayers, mechanics: d.mechanics, categories: d.categories, designers: d.designers,
    description: d.description, source: 'bgg', updated_at: new Date().toISOString() };
}

function decode_(s) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
    mdash: '—', ndash: '–', hellip: '…', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', times: '×', bull: '•' };
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] || m);
}

function bggSearch_(q) {
  q = q.trim();
  if (q.length < 2) return [];
  const direct = (String(q).match(/boardgame(?:expansion)?\/(\d+)/) || [])[1] || (/^\d+$/.test(q) ? q : '');
  if (direct) return [{ id: direct, name: 'BGG #' + direct, year: '' }];
  const out = [], seen = {};
  const root = bggFetch_('search?type=boardgame&query=' + encodeURIComponent(q));
  if (root) {
    root.getChildren('item').slice(0, 25).forEach(it => {
      const id = it.getAttribute('id').getValue();
      if (seen[id]) return; seen[id] = 1;
      const nm = it.getChild('name'), yr = it.getChild('yearpublished');
      out.push({ id: id, name: nm ? nm.getAttribute('value').getValue() : id, year: yr ? yr.getAttribute('value').getValue() : '' });
    });
  }
  const india = {};
  sb_('GET', 'offers?select=bgg_id,bgf_name&bgf_name=ilike.' + encodeURIComponent('*' + q.replace(/[*,()]/g, ' ') + '*') + '&limit=200')
    .forEach(o => { india[o.bgg_id] = o.bgf_name; });
  out.forEach(h => { if (india[h.id]) h.inIndia = true; });
  Object.keys(india).forEach(id => { if (!seen[id] && out.length < 30) { seen[id] = 1; out.push({ id: id, name: india[id], year: '', inIndia: true }); } });
  return out;
}

function bggDetails_(id) {
  if (!/^\d+$/.test(id)) throw new Error('Bad BGG id');
  const d = bggThings_([id])[id];
  if (!d) throw new Error('BoardGameGeek has no data for #' + id);
  const listings = sb_('GET', 'offers?select=listing,store,price,status,url&bgg_id=eq.' + id + '&order=price.asc');
  const cheapest = listings.filter(o => /in stock/i.test(o.status || '') && o.price)[0] || listings[0];
  d.suggest = suggest_(d, cheapest);
  d.offers = listings;
  return d;
}

const MECH_MAP = {
  'Cooperative Game': 'Cooperative', 'Deck, Bag, and Pool Building': 'Deck Building',
  'Hidden Roles': 'Hidden Roles', 'Open Drafting': 'Drafting', 'Closed Drafting': 'Drafting',
  'Card Drafting': 'Card Drafting', 'Tile Placement': 'Tile Placement', 'Worker Placement': 'Worker Placement',
  'Set Collection': 'Set Collection', 'Hand Management': 'Hand Management', 'Push Your Luck': 'Push Your Luck',
  'Area Majority / Influence': 'Area Control', 'Area Movement': 'Area Control', 'Trick-taking': 'Trick Taking',
  'Dice Rolling': 'Dice Rolling', 'Trading': 'Trading', 'Negotiation': 'Negotiation', 'Voting': 'Voting',
  'Team-Based Game': 'Team-Based', 'Variable Player Powers': 'Variable Player Powers', 'Auction/Bidding': 'Auction',
  'Network and Route Building': 'Network Building', 'Pattern Building': 'Pattern Building', 'Tableau Building': 'Tableau Building',
  'Engine Building': 'Engine Building', 'Deduction': 'Deduction', 'Bluffing': 'Bluffing', 'Real-Time': 'Real-Time',
  'Legacy Game': 'Campaign', 'Scenario / Mission / Campaign Game': 'Campaign',
  'Action Points': 'Action Points', 'Take That': 'Take That', 'Player Elimination': 'Player Elimination',
  'Communication Limits': 'Limited Communication', 'Hidden Movement': 'Hidden Movement', 'Race': 'Race',
  'Ladder Climbing': 'Ladder Climbing', 'Betting and Bluffing': 'Bluffing', 'Simultaneous Action Selection': 'Simultaneous Action Selection',
  'Dice Placement': 'Dice Placement', 'Tile Drafting': 'Tile Drafting', 'Role Selection': 'Role Selection'
};

function suggest_(d, cheapest) {
  const mech = d.mechanics || [], cats = d.categories || [];
  const has = (list, re) => list.some(x => re.test(x));
  let genre = 'Family Strategy';
  const rules = [
    [has(mech, /Cooperative/), 'Cooperative'], [has(mech, /Deck, Bag/), 'Deck Building'],
    [has(mech, /Hidden Roles/) || has(cats, /Deduction/) && has(cats, /Party|Bluff/), 'Social Deduction'],
    [has(mech, /Trick-taking/), 'Trick Taking'], [has(cats, /^Wargame$|Wars/), 'Wargame'],
    [has(cats, /Party Game/), 'Party'], [has(cats, /Abstract Strategy/), 'Abstract Strategy'],
    [has(cats, /Political/), 'Political Strategy'], [has(cats, /Economic/), 'Economic Strategy'],
    [has(cats, /Civilization/), 'Civilization'], [has(mech, /Tableau|Engine/), 'Engine Building'],
    [has(cats, /Bluffing/), 'Bluffing'], [has(cats, /Deduction/), 'Deduction'], [has(mech, /^Race$/) || has(cats, /Racing/), 'Racing'],
    [has(mech, /Push Your Luck/), 'Push Your Luck'], [has(cats, /Adventure|Exploration/), 'Adventure'],
    [has(mech, /Worker Placement/), 'Eurogame'], [has(mech, /Tile Placement/), 'Tile Placement'],
    [has(mech, /Set Collection/), 'Set Collection'], [has(cats, /Card Game/), 'Family Card Game']
  ];
  for (const r of rules) if (r[0]) { genre = r[1]; break; }
  const tags = [];
  mech.forEach(m => { const t = MECH_MAP[m]; if (t && tags.indexOf(t) < 0) tags.push(t); });
  if (+d.maxP === 2 && tags.indexOf('Two-Player') < 0) tags.push('Two-Player');
  const isCard = has(cats, /^Card Game$/);
  let category = 'Boards';
  if (+d.maxP === 2 && +d.minP <= 2) category = 'Duels';
  else if (isCard) category = 'Cards';
  return {
    category: category, alsoIn: category === 'Duels' && isCard ? 'Cards' : '', genre: genre, tags: tags.slice(0, 6).join(', '),
    price: cheapest ? cheapest.price : '', buyLink: cheapest ? cheapest.url : '', store: cheapest ? cheapest.store : ''
  };
}

/* ------------------------------------------------------------------ nightly jobs */

/** All Indian store listings from BGFinder -> offers. */
function refreshBgfinder() {
  const html = UrlFetchApp.fetch(BGF_URL, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 board-game-shelf' } }).getContentText();
  const a = html.indexOf('id="products-data">');
  if (a < 0) throw new Error('BGFinder page layout changed');
  const start = a + 'id="products-data">'.length;
  const data = JSON.parse(html.slice(start, html.indexOf('</script>', start)));
  const now = new Date().toISOString();
  const rows = data.filter(x => String(x.bggId || '').trim() && !x.Ignore).map(x => ({
    bgg_id: parseInt(x.bggId, 10), bgf_name: x.NamePrimary || null, store: x.store || null, listing: x.name || null,
    price: Math.round(parseFloat(x.priceValue)) || null, status: x.status || null, url: x.url || null, updated_at: now }));
  if (rows.length < 100) throw new Error('BGFinder returned only ' + rows.length + ' listings; keeping the old ones');
  sb_('DELETE', 'offers?id=gt.0');
  sbInsert_('offers', rows);
  return rows.length;
}

/** BGG data for games that have none, only partial data, or data older than 30 days (20 per request, 5 s apart). */
function fillBgg() {
  if (!props_().getProperty('BGG_TOKEN')) return 0;
  const ids = {};
  sbAll_('games?select=bgg_id&bgg_id=not.is.null').forEach(g => ids[g.bgg_id] = 1);
  const fresh = {};
  const cutoff = Date.now() - BGG_STALE_DAYS * 86400000;
  sbAll_('bgg?select=bgg_id,source,updated_at').forEach(b => { if (b.source === 'bgg' && Date.parse(b.updated_at) > cutoff) fresh[b.bgg_id] = 1; });
  const need = Object.keys(ids).filter(id => !fresh[id]).slice(0, 400);
  const started = Date.now();
  let done = 0;
  for (let i = 0; i < need.length && Date.now() - started < 240000; i += BGG_BATCH) {
    const got = bggThings_(need.slice(i, i + BGG_BATCH));
    const rows = Object.keys(got).map(id => bggRow_(got[id]));
    if (rows.length) sb_('POST', 'bgg?on_conflict=bgg_id', rows, 'resolution=merge-duplicates,return=minimal');
    done += rows.length;
    Utilities.sleep(BGG_PAUSE_MS);
  }
  Logger.log('BGG: refreshed ' + done + ' of ' + need.length);
  return done;
}

/** Daily rank + rating from the public BGG ranks file (no API call). */
function refreshRanks() {
  let csv = '';
  for (let back = 0; back < 4 && !csv; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const r = UrlFetchApp.fetch(RANKS_REPO + Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd') + '.csv', { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) csv = r.getContentText();
  }
  if (!csv) return 0;
  const have = {};
  sbAll_('bgg?select=bgg_id').forEach(b => have[b.bgg_id] = 1);
  const rows = Utilities.parseCsv(csv).slice(1).filter(r => have[r[0]])
    .map(r => ({ bgg_id: +r[0], rank: +r[3] || null, rating: +(+r[4]).toFixed(2) || null }));
  for (let i = 0; i < rows.length; i += 500) sb_('POST', 'bgg?on_conflict=bgg_id', rows.slice(i, i + 500), 'resolution=merge-duplicates,return=minimal');
  return rows.length;
}

/** Fills blank players / time / age / weight / genre / tags on games from BGG. */
function fillGameFields() {
  if (!props_().getProperty('BGG_TOKEN')) return 0;
  const games = sbAll_('games?select=id,bgg_id,min_players,max_players,min_time,max_time,age,weight,genre,tags&bgg_id=not.is.null' +
    '&or=(min_players.is.null,max_players.is.null,min_time.is.null,max_time.is.null,age.is.null,weight.is.null,genre.is.null)');
  let done = 0;
  for (let i = 0; i < games.length; i += BGG_BATCH) {
    const chunk = games.slice(i, i + BGG_BATCH);
    const got = bggThings_(chunk.map(g => g.bgg_id));
    chunk.forEach(g => {
      const d = got[g.bgg_id];
      if (!d) return;
      const s = suggest_(d, null), patch = {};
      [['min_players', d.minP], ['max_players', d.maxP], ['min_time', d.minT], ['max_time', d.maxT], ['age', d.age], ['weight', d.weight], ['genre', s.genre]]
        .forEach(([k, v]) => { if (g[k] == null && v != null && v !== '') patch[k] = v; });
      if (!(g.tags || []).length && s.tags) patch.tags = s.tags.split(', ');
      if (Object.keys(patch).length) { sb_('PATCH', 'games?id=eq.' + g.id, patch); done++; }
    });
    Utilities.sleep(BGG_PAUSE_MS);
  }
  return done;
}

/** Counterfeit / budget sellers on Shopify: top 3 matching listings per game per store -> fakes (source scrape). */
function refreshCounterfeit() {
  const stores = sb_('GET', 'stores?select=name,url&kind=eq.counterfeit&url=not.is.null');
  const games = sbAll_('games?select=id,name').map(g => ({ id: g.id, key: ' ' + normT_(g.name) + ' ' }));
  const VARIANT = /\b(expansion|extension|mini|junior|kids|pocket|travel|first journey|damage|damaged|sleeves?|insert|organi[sz]er|playmat|promo|booster|refill|replacement|puzzle|jigsaw|keychain|t shirt|poster)\b/;
  const GENERIC = { '': 1, board: 1, card: 1, game: 1, games: 1, strategy: 1, party: 1, family: 1, the: 1, by: 1, from: 1, english: 1, hindi: 1, edition: 1, original: 1, classic: 1, base: 1, core: 1, new: 1, deluxe: 1, cooperative: 1, a: 1, award: 1, trade: 1, '2': 1 };
  const out = [], now = new Date().toISOString();
  stores.forEach(s => {
    let host;
    try { host = s.url.match(/^https?:\/\/([^/]+)/)[1]; } catch (e) { return; }
    const products = [];
    for (let page = 1; page <= 40; page++) {
      const r = UrlFetchApp.fetch('https://' + host + '/products.json?limit=250&page=' + page, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 board-game-shelf' } });
      if (r.getResponseCode() !== 200) break;
      let list;
      try { list = JSON.parse(r.getContentText()).products || []; } catch (e) { break; }
      if (!list.length) break;
      list.forEach(p => products.push({ title: p.title, key: ' ' + normT_(p.title) + ' ', handle: p.handle,
        price: Math.round(+(p.variants && p.variants[0] && p.variants[0].price || 0)), inStock: (p.variants || []).some(v => v.available) }));
    }
    games.forEach(g => {
      products.filter(p => {
        const i = p.key.indexOf(g.key);
        if (i < 0) return false;
        if (VARIANT.test(p.key.replace(g.key, ' ')) && !VARIANT.test(g.key)) return false;
        const next = p.key.slice(i + g.key.length).trim().split(' ')[0] || '';
        const short = g.key.trim().split(' ').length === 1 && g.key.trim().length <= 6;
        return !short || GENERIC[next];
      }).sort((a, b) => (b.inStock - a.inStock) || (a.price - b.price)).slice(0, 3)
        .forEach(p => out.push({ game_id: g.id, store: s.name, listing: p.title, price: p.price || null, in_stock: p.inStock,
          url: 'https://' + host + '/products/' + p.handle, source: 'scrape', updated_at: now }));
    });
  });
  sb_('DELETE', 'fakes?source=eq.scrape');
  sbInsert_('fakes', out);
  return out.length;
}

function normT_(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/* ------------------------------------------------------------------ database -> Google Sheet mirror */

/**
 * The database is the source of truth. Each night (and on demand) the owner's data is copied into
 * BOARDS / CARDS / DUELS (status, interest, game details) and OWNED (price paid, rating, plays,
 * edition, authenticity), so the sheet's own SUMMARY and BUY LIST formulas keep working.
 * Games added on the website are appended to the right tab.
 */
function mirrorSheet() {
  const owner = sb_('GET', 'profiles?select=id&is_admin=eq.true&order=created_at.asc&limit=1')[0];
  const games = sbAll_('games?select=id,name,category,also_in,min_players,max_players,min_time,max_time,age,weight,genre,tags,list_price,buy_link,bgg_id&order=id');
  const mine = {};
  if (owner) sbAll_('user_games?select=*&user_id=eq.' + owner.id).forEach(u => mine[u.game_id] = u);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let written = 0;
  Object.keys(CAT_TABS).forEach(tab => {
    const sh = ss.getSheetByName(tab);
    if (!sh) return;
    const last = Math.max(sh.getLastRow(), 1);
    const width = COL.ALSO;
    const data = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
    const at = {};
    data.forEach((r, i) => { if (String(r[0]).trim()) at[norm_(r[0])] = i; });
    games.filter(g => g.category === CAT_TABS[tab]).forEach(g => {
      const u = mine[g.id] || {};
      let i = at[norm_(g.name)];
      if (i == null) { i = data.length; data.push(new Array(width).fill('')); at[norm_(g.name)] = i; }
      const r = data[i];
      const set = (col, v) => { r[col - 1] = v == null ? '' : v; };
      set(COL.GAME, g.name); set(COL.MINP, g.min_players); set(COL.MAXP, g.max_players); set(COL.MINT, g.min_time);
      set(COL.MAXT, g.max_time); set(COL.AGE, g.age); set(COL.WEIGHT, g.weight); set(COL.GENRE, g.genre);
      set(COL.TAGS, (g.tags || []).join(', ')); set(COL.STATUS, u.status || 'Wishlist'); set(COL.PRICE, g.list_price);
      set(COL.LINK, g.buy_link); set(COL.BGG, g.bgg_id ? 'https://boardgamegeek.com/boardgame/' + g.bgg_id : '');
      set(COL.INTEREST, u.interest); set(COL.SINCE, u.interest_since ? new Date(u.interest_since) : '');
      set(COL.ALSO, (g.also_in || []).join(', '));
      written++;
    });
    if (data.length) {
      if (data.length + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), data.length + 1 - sh.getMaxRows());
      if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
      sh.getRange(2, 1, data.length, width).setValues(data);
    }
  });
  const os = ss.getSheetByName(OWNED_TAB);
  if (os && owner) {
    if (os.getMaxColumns() < OWNED_EDITION_COL) os.insertColumnsAfter(os.getMaxColumns(), OWNED_EDITION_COL - os.getMaxColumns());
    const n = Math.max(os.getLastRow(), 1);
    const names = n > 1 ? os.getRange(2, 1, n - 1, 1).getDisplayValues().map(r => norm_(r[0])) : [];
    const byId = {};
    games.forEach(g => byId[g.id] = g);
    Object.keys(mine).forEach(id => {
      const u = mine[id], g = byId[id];
      if (!g) return;
      const ownedish = ['Owned', 'On the way', 'DIY'].indexOf(u.status) >= 0;
      const personal = u.authenticity || u.price_paid != null || u.rating != null || u.plays || u.edition;
      if (!ownedish && !personal) return;
      let row = names.indexOf(norm_(g.name));
      if (row < 0) { names.push(norm_(g.name)); row = names.length - 1; os.getRange(row + 2, 1).setValue(g.name); }
      os.getRange(row + 2, 3, 1, 4).setValues([[u.authenticity || '', u.price_paid == null ? '' : u.price_paid, u.rating == null ? '' : u.rating, u.plays || '']]);
      os.getRange(row + 2, OWNED_EDITION_COL).setValue(u.edition || '');
    });
  }
  return written;
}

/* ------------------------------------------------------------------ schedule */

function nightly() {
  const steps = [refreshBgfinder, fillBgg, refreshRanks, fillGameFields, refreshCounterfeit, mirrorSheet];
  steps.forEach(fn => { try { Logger.log(fn.name + ': ' + fn()); } catch (e) { Logger.log(fn.name + ' failed: ' + e.message); } });
}

/** Run once from the editor after pasting this file: checks the settings and schedules the nightly job. */
function setup() {
  ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'WELCOME_SECRET', 'BGG_TOKEN'].forEach(prop_);
  sb_('GET', 'games?select=id&limit=1');   // proves the database connection works
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(4).create();
  GmailApp.getAliases();                    // asks for Gmail permission now, not during the first sign-up
  Logger.log('Ready. Nightly job scheduled for 4 am.');
}
