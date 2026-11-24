/**
 * Board Game Shelf: backend (Google Apps Script web app)
 * ------------------------------------------------------
 * A STANDALONE script (script.google.com > New project) that uses your
 * Google Sheet as the database. Being standalone means it can never clash
 * with the "Board Games" v4 script that already lives inside the sheet.
 *
 * Deploy:  Deploy > New deployment > Web app
 *          Execute as: Me        Who has access: Anyone
 * Script properties (Project Settings > Script properties):
 *   GOOGLE_CLIENT_ID  OAuth Web client ID (the same one used in config.js)   [required]
 *   ADMIN_EMAILS      comma list of emails allowed to add games (default: you, the script owner)
 *   BGG_TOKEN         BoardGameGeek API application token (optional, boardgamegeek.com/applications)
 * Then run setup() once from the editor.
 *
 * Public callers get the catalogue only: no STATUS, INTEREST, price paid or ratings.
 * Signed-in callers get their own data. Only ADMIN_EMAILS can add games, and only
 * an admin's data is written into BOARDS/CARDS/DUELS + OWNED. Everyone else goes to USER_DATA.
 */

const SHEET_ID = '1bVzKKQcmN8jfEko9kLpyU68IGIFu5IYuD-vKCl3TtDc';
const CAT_TABS = { BOARDS: 'Boards', CARDS: 'Cards', DUELS: 'Duels' };
const COL = { GAME: 1, MINP: 2, MAXP: 3, MINT: 4, MAXT: 5, AGE: 6, WEIGHT: 7, GENRE: 8, TAGS: 9,
  STATUS: 10, PRICE: 11, LINK: 12, BGG: 13, INTEREST: 14, SINCE: 15, ALSO: 16 };
const OWNED_TAB = 'OWNED';
const TAB_CACHE = 'BGG_CACHE';
const TAB_BGF = 'BGFINDER_PRICES';
const TAB_USERS = 'USER_DATA';
const TAB_FAKE = 'COUNTERFEIT';
const BGF_URL = 'https://www.bgfindertool.com/';
const CACHE_KEY = 'catalog_v1';

const CACHE_HEAD = ['BGG ID', 'NAME', 'YEAR', 'IMAGE', 'THUMB', 'BGG RATING', 'BGG RANK', 'WEIGHT',
  'MECHANICS', 'CATEGORIES', 'DESIGNERS', 'BEST PLAYERS', 'DESCRIPTION', 'UPDATED'];
const BGF_HEAD = ['BGG ID', 'LISTING', 'STORE', 'PRICE', 'STATUS', 'URL', 'NAME', 'MIN P', 'MAX P',
  'MIN T', 'MAX T', 'AGE', 'YEAR', 'WEIGHT', 'RATING', 'RANK', 'IMAGE', 'THUMB', 'MECHANICS',
  'CATEGORIES', 'DESIGNERS', 'DESCRIPTION', 'UPDATED'];
const USER_HEAD = ['EMAIL', 'GAME', 'STATUS', 'INTEREST', 'INTEREST SINCE', 'AUTHENTICITY',
  'PRICE PAID', 'RATING /10', 'TIMES PLAYED', 'NOTES', 'UPDATED'];

/* ------------------------------------------------------------------ HTTP */

function doGet(e) {
  const p = (e && e.parameter) || {};
  return route_(p.action || 'catalog', p);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return route_(body.action, body);
}

function route_(action, req) {
  try {
    let out;
    switch (action) {
      case 'catalog': out = getCatalog_(req.fresh === '1' || req.fresh === true); break;
      case 'me': out = getMine_(auth_(req)); break;
      case 'saveMine': out = saveMine_(auth_(req), req.game, req.fields || {}); break;
      case 'bggSearch': admin_(req); out = bggSearch_(String(req.q || '')); break;
      case 'bggDetails': admin_(req); out = bggDetails_(String(req.id || '')); break;
      case 'addGame': out = addGame_(admin_(req), req.game || {}); break;
      case 'refresh': admin_(req); refreshBgfinder(); fillBggCache(); out = { ok: true }; break;
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

/* ------------------------------------------------------------------ auth */

function props_() { return PropertiesService.getScriptProperties(); }

function auth_(req) {
  const token = req.idToken;
  if (!token) throw new Error('Sign in first');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' +
    encodeURIComponent(token), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Sign-in expired, please sign in again');
  const p = JSON.parse(r.getContentText());
  const clientId = props_().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId || p.aud !== clientId) throw new Error('Sign-in not accepted (client ID mismatch)');
  if (String(p.email_verified) !== 'true') throw new Error('Email not verified');
  const user = { email: String(p.email).toLowerCase(), name: p.name || p.email };
  user.isAdmin = adminEmails_().indexOf(user.email) >= 0;
  cache.put(key, JSON.stringify(user), 3000);
  return user;
}

function admin_(req) {
  const u = auth_(req);
  if (!u.isAdmin) throw new Error('Only the owner can do this');
  return u;
}

function adminEmails_() {
  const raw = props_().getProperty('ADMIN_EMAILS') || Session.getEffectiveUser().getEmail() || '';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(String);
}

/* ------------------------------------------------------------------ sheet helpers */

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }

function tab_(name, head) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh && head) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setTabColor('#9e9e9e');
  }
  return sh;
}

function lastRowIn_(sh, col) {
  const n = sh.getLastRow();
  if (n < 2) return 1;
  const v = sh.getRange(1, col, n, 1).getDisplayValues();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]).trim()) return i + 1;
  return 1;
}

function num_(s) {
  const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function bggId_(link) {
  const m = String(link || '').match(/boardgame(?:expansion)?\/(\d+)/);
  return m ? m[1] : '';
}

function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function rowsOf_(sh) {
  const n = lastRowIn_(sh, COL.GAME);
  if (n < 2) return [];
  const width = Math.max(sh.getLastColumn(), COL.SINCE);
  return sh.getRange(2, 1, n - 1, width).getDisplayValues()
    .map((r, i) => ({ r: r, row: i + 2 }))
    .filter(x => String(x.r[0]).trim());
}

function findGame_(name) {
  const ss = ss_();
  const key = norm_(name);
  for (const t in CAT_TABS) {
    const sh = ss.getSheetByName(t);
    if (!sh) continue;
    const hit = rowsOf_(sh).find(x => norm_(x.r[0]) === key);
    if (hit) return { sh: sh, row: hit.row, r: hit.r, tab: t };
  }
  return null;
}

/* ------------------------------------------------------------------ catalogue (public) */

function getCatalog_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const n = cache.get(CACHE_KEY + '_n');
    if (n) {
      const parts = cache.getAll(Array.from({ length: +n }, (_, i) => CACHE_KEY + '_' + i));
      const s = Array.from({ length: +n }, (_, i) => parts[CACHE_KEY + '_' + i]).join('');
      if (s && Object.keys(parts).length === +n) return JSON.parse(s);
    }
  }
  const out = buildCatalog_();
  const s = JSON.stringify(out);
  const size = 90000, chunks = {};
  let i = 0;
  for (; i * size < s.length; i++) chunks[CACHE_KEY + '_' + i] = s.slice(i * size, (i + 1) * size);
  chunks[CACHE_KEY + '_n'] = String(i);
  try { cache.putAll(chunks, 600); } catch (e) {}
  return out;
}

function bustCache_() {
  CacheService.getScriptCache().remove(CACHE_KEY + '_n');
}

function buildCatalog_() {
  const ss = ss_();
  const cache = {};
  const cs = ss.getSheetByName(TAB_CACHE);
  if (cs && cs.getLastRow() > 1) {
    cs.getRange(2, 1, cs.getLastRow() - 1, CACHE_HEAD.length).getDisplayValues().forEach(r => {
      if (r[0]) cache[r[0]] = r;
    });
  }
  const offers = {};
  const bs = ss.getSheetByName(TAB_BGF);
  let bgfUpdated = '';
  if (bs && bs.getLastRow() > 1) {
    bs.getRange(2, 1, bs.getLastRow() - 1, 6).getValues().forEach(r => {
      if (!r[0]) return;
      (offers[r[0]] = offers[r[0]] || []).push({ listing: r[1], store: r[2], price: num_(r[3]), status: r[4], url: r[5] });
    });
    bgfUpdated = bs.getRange(2, BGF_HEAD.length).getDisplayValue();
  }
  const games = [];
  for (const t in CAT_TABS) {
    const sh = ss.getSheetByName(t);
    if (!sh) continue;
    rowsOf_(sh).forEach(x => {
      const r = x.r;
      const id = bggId_(r[COL.BGG - 1]);
      const c = cache[id];
      const also = String(r[COL.ALSO - 1] || '').split(/[,/]/).map(s => s.trim()).filter(String);
      games.push({
        name: String(r[0]).trim(),
        category: CAT_TABS[t],
        alsoIn: also,
        minP: num_(r[1]), maxP: num_(r[2]), minT: num_(r[3]), maxT: num_(r[4]), age: num_(r[5]),
        weight: num_(r[6]), genre: r[7], tags: String(r[8] || '').split(',').map(s => s.trim()).filter(String),
        price: num_(r[10]), buyLink: r[11], bggLink: r[12], bggId: id,
        year: c ? num_(c[2]) : null, image: c ? c[3] : '', thumb: c ? c[4] : '',
        bggRating: c ? num_(c[5]) : null, bggRank: c ? num_(c[6]) : null,
        mechanics: c && c[8] ? c[8].split('|') : [], bggCategories: c && c[9] ? c[9].split('|') : [],
        designers: c && c[10] ? c[10].split('|') : [], bestPlayers: c ? c[11] : '',
        description: c ? String(c[12]).slice(0, 700) : '',
        offers: (offers[id] || []).sort((a, b) => (a.price || 1e9) - (b.price || 1e9))
      });
    });
  }
  return { games: games, stores: stores_(), counterfeit: counterfeit_(), genres: genres_(), bgfUpdated: bgfUpdated, built: new Date().toISOString() };
}

function guideBlock_(headerText, colIndex, width) {
  const sh = ss_().getSheetByName('GUIDE');
  if (!sh) return [];
  const v = sh.getRange(1, 1, sh.getLastRow(), 6).getDisplayValues();
  const start = v.findIndex(r => String(r[colIndex]).trim().toUpperCase() === headerText);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < v.length; i++) {
    const cell = String(v[i][colIndex]).trim();
    if (!cell) break;
    out.push(v[i].slice(colIndex, colIndex + width));
  }
  return out;
}

function stores_() {
  return guideBlock_('STORE', 4, 2).map(r => ({ name: r[0], url: r[1] }));
}

function genres_() {
  return guideBlock_('GENRE', 0, 3).map(r => ({ name: r[0], meaning: r[1], example: r[2] }));
}

function counterfeit_() {
  const sh = ss_().getSheetByName(TAB_FAKE);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getDisplayValues()
    .filter(r => r[0]).map(r => ({ name: r[0], url: r[1], search: r[2] }));
}

/* ------------------------------------------------------------------ personal data */

function getMine_(user) {
  const items = {};
  if (user.isAdmin) {
    const ss = ss_();
    for (const t in CAT_TABS) {
      const sh = ss.getSheetByName(t);
      if (!sh) continue;
      const rows = rowsOf_(sh);
      if (!rows.length) continue;
      const since = sh.getRange(2, COL.SINCE, rows[rows.length - 1].row - 1, 1).getValues();
      rows.forEach(x => {
        const sv = since[x.row - 2] && since[x.row - 2][0];
        items[String(x.r[0]).trim()] = { status: x.r[COL.STATUS - 1] || 'Wishlist', interest: x.r[COL.INTEREST - 1] || '',
          since: sv instanceof Date ? sv.toISOString() : String(sv || '') };
      });
    }
    const os = ss.getSheetByName(OWNED_TAB);
    if (os && os.getLastRow() > 1) {
      os.getRange(2, 1, os.getLastRow() - 1, 6).getDisplayValues().forEach(r => {
        const name = String(r[0]).trim();
        if (!name) return;
        const it = items[name] = items[name] || {};
        it.authenticity = r[2]; it.pricePaid = num_(r[3]); it.rating = num_(r[4]); it.plays = num_(r[5]);
      });
    }
  } else {
    const sh = tab_(TAB_USERS, USER_HEAD);
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, USER_HEAD.length).getValues().forEach(r => {
        if (String(r[0]).toLowerCase() !== user.email) return;
        items[r[1]] = { status: r[2], interest: r[3], since: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || ''), authenticity: r[5], pricePaid: num_(r[6]),
          rating: num_(r[7]), plays: num_(r[8]), notes: r[9] };
      });
    }
  }
  return { email: user.email, name: user.name, isAdmin: user.isAdmin, items: items };
}

const STATUSES = ['Wishlist', 'On the way', 'Owned', 'DIY', ''];
const INTERESTS = ['Really want', 'Normal', 'Maybe', ''];
const AUTHS = ['VERIFIED ORIGINAL', 'SUSPECTED COUNTERFEIT', 'UNKNOWN', ''];

function clean_(f) {
  const o = {};
  if ('status' in f) { if (STATUSES.indexOf(f.status) < 0) throw new Error('Bad status'); o.status = f.status; }
  if ('interest' in f) { if (INTERESTS.indexOf(f.interest) < 0) throw new Error('Bad interest'); o.interest = f.interest; }
  if ('authenticity' in f) { if (AUTHS.indexOf(f.authenticity) < 0) throw new Error('Bad authenticity'); o.authenticity = f.authenticity; }
  ['pricePaid', 'rating', 'plays'].forEach(k => {
    if (k in f) {
      const n = f[k] === '' || f[k] == null ? '' : Number(f[k]);
      if (n !== '' && (isNaN(n) || n < 0 || (k === 'rating' && n > 10))) throw new Error('Bad ' + k);
      o[k] = n;
    }
  });
  if ('notes' in f) o.notes = String(f.notes || '').slice(0, 500);
  return o;
}

function saveMine_(user, game, fields) {
  const g = findGame_(game);
  if (!g) throw new Error('Game not found');
  const name = String(g.r[0]).trim();
  const f = clean_(fields);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (user.isAdmin) saveAdmin_(g, name, f);
    else saveUser_(user, name, f);
  } finally { lock.releaseLock(); }
  return getMine_(user).items[name] || {};
}

function saveAdmin_(g, name, f) {
  // Same columns the sheet's own script reads, so BUY LIST / SUMMARY keep working.
  if ('status' in f) g.sh.getRange(g.row, COL.STATUS).setValue(f.status);
  if ('interest' in f) {
    g.sh.getRange(g.row, COL.INTEREST).setValue(f.interest);
    g.sh.getRange(g.row, COL.SINCE).setValue(f.interest ? new Date() : '');
  }
  const status = 'status' in f ? f.status : g.r[COL.STATUS - 1];
  const ownedish = ['Owned', 'On the way', 'DIY'].indexOf(status) >= 0;
  const personal = ['authenticity', 'pricePaid', 'rating', 'plays'].some(k => k in f);
  if (!ownedish && !personal) return;
  const os = ss_().getSheetByName(OWNED_TAB);
  if (!os) return;
  const n = lastRowIn_(os, 1);
  const names = n > 1 ? os.getRange(2, 1, n - 1, 1).getDisplayValues().map(r => norm_(r[0])) : [];
  let row = names.indexOf(norm_(name));
  if (row >= 0) row += 2;
  else if (ownedish) { row = n + 1; os.getRange(row, 1, 1, 2).setValues([[name, status]]); }
  else return;
  if ('status' in f && ownedish) os.getRange(row, 2).setValue(status);
  if ('authenticity' in f) os.getRange(row, 3).setValue(f.authenticity);
  if ('pricePaid' in f) os.getRange(row, 4).setValue(f.pricePaid);
  if ('rating' in f) os.getRange(row, 5).setValue(f.rating);
  if ('plays' in f) os.getRange(row, 6).setValue(f.plays);
}

function saveUser_(user, name, f) {
  const sh = tab_(TAB_USERS, USER_HEAD);
  const n = sh.getLastRow();
  const v = n > 1 ? sh.getRange(2, 1, n - 1, USER_HEAD.length).getValues() : [];
  let i = v.findIndex(r => String(r[0]).toLowerCase() === user.email && norm_(r[1]) === norm_(name));
  const row = i >= 0 ? v[i] : [user.email, name, '', '', '', '', '', '', '', '', ''];
  const map = { status: 2, interest: 3, authenticity: 5, pricePaid: 6, rating: 7, plays: 8, notes: 9 };
  for (const k in f) row[map[k]] = f[k];
  if ('interest' in f) row[4] = f.interest ? new Date() : '';
  row[10] = new Date();
  if (i >= 0) sh.getRange(i + 2, 1, 1, USER_HEAD.length).setValues([row]);
  else sh.appendRow(row);
}

/* ------------------------------------------------------------------ BGG + BGFinder */

function bggFetch_(path) {
  const token = props_().getProperty('BGG_TOKEN');
  if (!token) return null;
  const r = UrlFetchApp.fetch('https://boardgamegeek.com/xmlapi2/' + path, {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (r.getResponseCode() === 202) { Utilities.sleep(2000); return bggFetch_(path); }
  if (r.getResponseCode() !== 200) return null;
  return XmlService.parse(r.getContentText()).getRootElement();
}

function bgfRows_() {
  const sh = ss_().getSheetByName(TAB_BGF);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, BGF_HEAD.length).getValues();
}

function bggSearch_(q) {
  q = q.trim();
  if (q.length < 2) return [];
  const out = [], seen = {};
  const direct = bggId_(q) || (/^\d+$/.test(q) ? q : '');
  if (direct) return [{ id: direct, name: 'BGG #' + direct, year: '' }];
  const root = bggFetch_('search?type=boardgame&query=' + encodeURIComponent(q));
  if (root) {
    root.getChildren('item').slice(0, 25).forEach(it => {
      const id = it.getAttribute('id').getValue();
      if (seen[id]) return; seen[id] = 1;
      const nm = it.getChild('name'), yr = it.getChild('yearpublished');
      out.push({ id: id, name: nm ? nm.getAttribute('value').getValue() : id, year: yr ? yr.getAttribute('value').getValue() : '' });
    });
  }
  const k = norm_(q);
  bgfRows_().forEach(r => {
    if (out.length >= 30 || !r[0] || seen[r[0]]) return;
    if (norm_(r[6]).indexOf(k) >= 0 || norm_(r[1]).indexOf(k) >= 0) {
      seen[r[0]] = 1;
      out.push({ id: String(r[0]), name: r[6] || r[1], year: r[12] || '', inIndia: true });
    }
  });
  return out;
}

function bggDetails_(id, bgfCache) {
  if (!/^\d+$/.test(id)) throw new Error('Bad BGG id');
  let d = null;
  const root = bggFetch_('thing?stats=1&id=' + id);
  const item = root && root.getChild('item');
  if (item) {
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
    d = {
      id: id, name: primary ? primary.getAttribute('value').getValue() : id,
      year: val('yearpublished'), minP: +val('minplayers'), maxP: +val('maxplayers'),
      minT: +val('minplaytime') || +val('playingtime'), maxT: +val('maxplaytime') || +val('playingtime'),
      age: +val('minage'), weight: +(+st.getChild('averageweight').getAttribute('value').getValue()).toFixed(2),
      rating: +(+st.getChild('average').getAttribute('value').getValue()).toFixed(2),
      rank: rank ? rank.getAttribute('value').getValue() : '',
      image: item.getChildText('image') || '', thumb: item.getChildText('thumbnail') || '',
      mechanics: links('boardgamemechanic'), categories: links('boardgamecategory'),
      designers: links('boardgamedesigner'), bestPlayers: best,
      description: decode_(item.getChildText('description') || '')
    };
  }
  const listings = (bgfCache || bgfRows_()).filter(r => String(r[0]) === id);
  if (!d && listings.length) {
    const r = listings[0];
    d = { id: id, name: r[6] || r[1], year: r[12], minP: r[7], maxP: r[8], minT: r[9], maxT: r[10], age: r[11],
      weight: r[13] ? +(+r[13]).toFixed(2) : '', rating: r[14] ? +(+r[14]).toFixed(2) : '', rank: r[15],
      image: r[16], thumb: r[17], mechanics: String(r[18]).split('|').filter(String),
      categories: String(r[19]).split('|').filter(String), designers: String(r[20]).split('|').filter(String),
      bestPlayers: '', description: r[21] };
  }
  if (!d) throw new Error('No data for this game. Add a BGG_TOKEN script property, or fill the fields in by hand.');
  const cheapest = listings.filter(r => /in stock/i.test(r[4])).sort((a, b) => a[3] - b[3])[0] || listings[0];
  d.suggest = suggest_(d, cheapest);
  d.offers = listings.map(r => ({ listing: r[1], store: r[2], price: r[3], status: r[4], url: r[5] }));
  return d;
}

function decode_(s) {
  return String(s).replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&[a-z]+;/g, ' ');
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
  'Campaign / Battle Card Driven': 'Campaign', 'Legacy Game': 'Campaign', 'Scenario / Mission / Campaign Game': 'Campaign',
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
  const alsoIn = [];
  if (category === 'Duels' && isCard) alsoIn.push('Cards');
  return {
    category: category, alsoIn: alsoIn.join(', '), genre: genre, tags: tags.slice(0, 6).join(', '),
    price: cheapest ? cheapest[3] : '', buyLink: cheapest ? cheapest[5] : '', store: cheapest ? cheapest[2] : ''
  };
}

function addGame_(user, g) {
  const name = String(g.name || '').trim();
  if (!name) throw new Error('Name required');
  const tabName = Object.keys(CAT_TABS).find(t => CAT_TABS[t] === g.category);
  if (!tabName) throw new Error('Pick Boards, Cards or Duels');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findGame_(name)) throw new Error(name + ' is already in the sheet');
    const sh = ss_().getSheetByName(tabName);
    ensureAlsoCol_(sh);
    const row = lastRowIn_(sh, COL.GAME) + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
    const id = String(g.bggId || '').replace(/\D/g, '');
    const status = STATUSES.indexOf(g.status) >= 0 && g.status ? g.status : 'Wishlist';
    const n = (v) => v === '' || v == null || isNaN(Number(v)) ? '' : Number(v);
    sh.getRange(row, 1, 1, 13).setValues([[
      name, n(g.minP), n(g.maxP), n(g.minT), n(g.maxT), n(g.age), n(g.weight),
      g.genre || '', g.tags || '', status, g.price ? Number(g.price) : '', g.buyLink || '',
      id ? 'https://boardgamegeek.com/boardgame/' + id : (g.bggLink || '')
    ]]);
    if (g.interest && INTERESTS.indexOf(g.interest) >= 0) {
      sh.getRange(row, COL.INTEREST, 1, 2).setValues([[g.interest, new Date()]]);
    }
    if (g.alsoIn) sh.getRange(row, COL.ALSO).setValue(g.alsoIn);
    if (id && g.details) writeCache_(id, g.details);
    if (['Owned', 'On the way', 'DIY'].indexOf(status) >= 0) {
      saveAdmin_(findGame_(name), name, { status: status });
    }
  } finally { lock.releaseLock(); }
  bustCache_();
  return { ok: true, name: name };
}

function ensureAlsoCol_(sh) {
  if (sh.getMaxColumns() < COL.ALSO) sh.insertColumnsAfter(sh.getMaxColumns(), COL.ALSO - sh.getMaxColumns());
  const h = sh.getRange(1, COL.ALSO);
  if (!h.getDisplayValue()) {
    h.setValue('ALSO IN').setFontWeight('bold');
    h.setNote('Optional: other categories this game also counts as, e.g. "Duels" or "Cards, Duels". Used by the website filters.');
  }
}

function writeCache_(id, d) {
  const sh = tab_(TAB_CACHE, CACHE_HEAD);
  const row = [id, d.name || '', d.year || '', d.image || '', d.thumb || '', d.rating || '', d.rank || '', d.weight || '',
    (d.mechanics || []).join('|'), (d.categories || []).join('|'), (d.designers || []).join('|'), d.bestPlayers || '',
    String(d.description || '').slice(0, 1500), new Date()];
  const n = sh.getLastRow();
  const ids = n > 1 ? sh.getRange(2, 1, n - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const i = ids.indexOf(id);
  if (i >= 0) sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

/* ------------------------------------------------------------------ scheduled jobs (run from editor / trigger) */

/** Pulls the live Indian store listings from BGFinder into BGFINDER_PRICES. */
function refreshBgfinder() {
  const html = UrlFetchApp.fetch(BGF_URL, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 board-game-shelf' } }).getContentText();
  const a = html.indexOf('id="products-data">');
  if (a < 0) throw new Error('BGFinder page layout changed');
  const start = a + 'id="products-data">'.length;
  const data = JSON.parse(html.slice(start, html.indexOf('</script>', start)));
  const now = new Date();
  const rows = data.filter(x => x.bggId && !x.Ignore).map(x => [
    String(x.bggId), x.name || '', x.store || '', x.priceValue || '', x.status || '', x.url || '',
    x.NamePrimary || '', x.playersMin || '', x.playersMax || '', x.playtimeMin || '', x.playtimeMax || '',
    x.minAgeValue || '', x.yearPublishedValue || '', x.bggWeight || '', x.bggRating || '', x.bggRank || '',
    x.Image || '', x.Thumbnail || '', (x.mechanicsList || []).join('|'), (x.categoriesList || []).join('|'),
    (x.designersList || []).join('|'), String(x.Description || '').slice(0, 1200), now
  ]);
  const sh = tab_(TAB_BGF, BGF_HEAD);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, BGF_HEAD.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, BGF_HEAD.length).setValues(rows);
  bustCache_();
  return rows.length;
}

/** Fills BGG_CACHE (art, rating, rank, mechanics) for every game in the sheet that has a BGG link. */
function fillBggCache() {
  const ss = ss_();
  const cs = tab_(TAB_CACHE, CACHE_HEAD);
  const have = {};
  if (cs.getLastRow() > 1) cs.getRange(2, 1, cs.getLastRow() - 1, 1).getDisplayValues().forEach(r => have[r[0]] = 1);
  const need = [];
  for (const t in CAT_TABS) {
    const sh = ss.getSheetByName(t);
    if (sh) rowsOf_(sh).forEach(x => { const id = bggId_(x.r[COL.BGG - 1]); if (id && !have[id] && need.indexOf(id) < 0) need.push(id); });
  }
  const started = Date.now();
  const bgf = bgfRows_();
  need.forEach(id => {
    if (Date.now() - started > 300000) return;   // stay under the 6 min limit; run again for the rest
    try { writeCache_(id, bggDetails_(id, bgf)); } catch (e) { Logger.log(id + ': ' + e.message); }
  });
  bustCache_();
  Logger.log('Cached ' + need.length + ' games');
}

function nightly() { refreshBgfinder(); fillBggCache(); }

/** Run once from the editor. Creates the helper tabs, adds ALSO IN, schedules a nightly refresh. */
function setup() {
  Object.keys(CAT_TABS).forEach(t => { const sh = ss_().getSheetByName(t); if (sh) ensureAlsoCol_(sh); });
  tab_(TAB_CACHE, CACHE_HEAD);
  tab_(TAB_BGF, BGF_HEAD);
  tab_(TAB_USERS, USER_HEAD);
  const fake = tab_(TAB_FAKE, ['STORE', 'WEBSITE', 'SEARCH URL ({q} = game name)']);
  if (fake.getLastRow() < 2) {
    fake.getRange(2, 1, 3, 3).setValues([
      ['Satyams', 'https://www.satyamstationers.com/', 'https://www.satyamstationers.com/search?q={q}'],
      ['Jaiman Toys', 'https://jaimantoys.com/', 'https://jaimantoys.com/search?q={q}'],
      ['Shop Befikar', 'https://shopbefikar.com/', 'https://shopbefikar.com/search?q={q}']
    ]);
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'nightly').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(4).create();
  nightly();
}
