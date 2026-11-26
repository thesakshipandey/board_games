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
 *   GOOGLE_CLIENT_ID  optional: only if you change the OAuth client (DEFAULT_CLIENT_ID below is already set)
 *   ADMIN_EMAILS      comma list of emails allowed to add games (default: you, the script owner)
 *   BGG_TOKEN         BoardGameGeek XML API token (boardgamegeek.com/applications > your app > Tokens).
 *                     Keep it here only: never in this file or on the website.
 * Then run setup() once from the editor.
 *
 * Public callers get the catalogue only: no STATUS, INTEREST, price paid or ratings.
 * Signed-in callers get their own data. Only ADMIN_EMAILS can add games, and only
 * an admin's data is written into BOARDS/CARDS/DUELS + OWNED. Everyone else goes to USER_DATA.
 */

const SHEET_ID = '1bVzKKQcmN8jfEko9kLpyU68IGIFu5IYuD-vKCl3TtDc';
// Public value (it is also in the website's config.js). The GOOGLE_CLIENT_ID script property overrides it.
const DEFAULT_CLIENT_ID = '769471684180-3imp21jcvq210ap33fq14cdhs3uav20o.apps.googleusercontent.com';
const CAT_TABS = { BOARDS: 'Boards', CARDS: 'Cards', DUELS: 'Duels' };
const COL = { GAME: 1, MINP: 2, MAXP: 3, MINT: 4, MAXT: 5, AGE: 6, WEIGHT: 7, GENRE: 8, TAGS: 9,
  STATUS: 10, PRICE: 11, LINK: 12, BGG: 13, INTEREST: 14, SINCE: 15, ALSO: 16 };
const OWNED_TAB = 'OWNED';
const TAB_CACHE = 'BGG_CACHE';
const TAB_BGF = 'BGFINDER_PRICES';
const TAB_USERS = 'USER_DATA';
const TAB_FAKE = 'COUNTERFEIT';
const TAB_REG = 'USERS';
const REG_HEAD = ['EMAIL', 'DISPLAY NAME', 'USERNAME', 'JOINED', 'LAST SEEN'];
const BGF_URL = 'https://www.bgfindertool.com/';
const TAB_EXTRAS = 'EXTRAS';
const EXTRAS_HEAD = ['BASE GAME', 'TYPE', 'NAME', 'BGG LINK', 'PRICE ₹', 'STORE', 'BUY LINK', 'NOTE'];
const EXTRAS_SEED_URL = 'https://thesakshipandey.github.io/boardgame/data/extras.json';
const TAB_FAKE_PRICES = 'COUNTERFEIT_PRICES';
const TAB_FAKE_LIST = 'COUNTERFEIT_LIST';   // hand-kept prices (Funkky catalogue, Shop Befikar checks); never cleared
const FAKE_LIST_HEAD = ['GAME', 'STORE', 'LISTING', 'PRICE ₹', 'STATUS', 'URL', 'NOTE'];
const FAKE_LIST_SEED_URL = 'https://thesakshipandey.github.io/boardgame/data/counterfeit_list.json';
const FAKE_HEAD = ['GAME', 'STORE', 'LISTING', 'PRICE ₹', 'IN STOCK', 'URL', 'UPDATED'];
const RANKS_REPO = 'https://raw.githubusercontent.com/beefsack/bgg-ranking-historicals/master/';
const CACHE_KEY = 'catalog_v1';

const CACHE_HEAD = ['BGG ID', 'NAME', 'YEAR', 'IMAGE', 'THUMB', 'BGG RATING', 'BGG RANK', 'WEIGHT',
  'MECHANICS', 'CATEGORIES', 'DESIGNERS', 'BEST PLAYERS', 'DESCRIPTION', 'UPDATED'];
const BGF_HEAD = ['BGG ID', 'LISTING', 'STORE', 'PRICE', 'STATUS', 'URL', 'NAME', 'MIN P', 'MAX P',
  'MIN T', 'MAX T', 'AGE', 'YEAR', 'WEIGHT', 'RATING', 'RANK', 'IMAGE', 'THUMB', 'MECHANICS',
  'CATEGORIES', 'DESIGNERS', 'DESCRIPTION', 'UPDATED'];
const USER_HEAD = ['EMAIL', 'GAME', 'STATUS', 'INTEREST', 'INTEREST SINCE', 'AUTHENTICITY',
  'PRICE PAID', 'RATING /10', 'TIMES PLAYED', 'NOTES', 'UPDATED', 'EDITION'];
const OWNED_EDITION_COL = 12;   // OWNED!L

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
      case 'catalog': ensureSetup_(); out = getCatalog_(req.fresh === '1' || req.fresh === true); break;
      case 'summary': admin_(req); out = readSummary_(); break;
      case 'me': out = getMine_(auth_(req), true); break;
      case 'register': out = register_(auth_(req), req.name, req.username); break;
      case 'saveMine': out = saveMine_(requireReg_(auth_(req)), req.game, req.fields || {}); break;
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
  const allowed = [DEFAULT_CLIENT_ID].concat(String(props_().getProperty('GOOGLE_CLIENT_ID') || '').split(','))
    .map(x => x.replace(/["'\s]/g, '')).filter(String);
  if (allowed.indexOf(p.aud) < 0) throw new Error('Sign-in not accepted (client ID mismatch: ' + String(p.aud).slice(0, 12) + '…)');
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
  const extras = {};
  const es = ss.getSheetByName(TAB_EXTRAS);
  if (es && es.getLastRow() > 1) {
    es.getRange(2, 1, es.getLastRow() - 1, EXTRAS_HEAD.length).getDisplayValues().forEach(r => {
      if (!r[0] || !r[2]) return;
      (extras[norm_(r[0])] = extras[norm_(r[0])] || []).push({ type: r[1], name: r[2], bgg: r[3], price: num_(r[4]), store: r[5], buy: r[6], note: r[7] });
    });
  }
  const fakes = {};
  const fs = ss.getSheetByName(TAB_FAKE_PRICES);
  if (fs && fs.getLastRow() > 1) {
    fs.getRange(2, 1, fs.getLastRow() - 1, 6).getValues().forEach(r => {
      if (!r[0]) return;
      (fakes[norm_(r[0])] = fakes[norm_(r[0])] || []).push({ store: r[1], listing: r[2], price: num_(r[3]), inStock: r[4] === true || r[4] === 'TRUE', url: r[5] });
    });
  }
  const fl = ss.getSheetByName(TAB_FAKE_LIST);
  if (fl && fl.getLastRow() > 1) {
    fl.getRange(2, 1, fl.getLastRow() - 1, FAKE_LIST_HEAD.length).getDisplayValues().forEach(r => {
      if (!r[0]) return;
      (fakes[norm_(r[0])] = fakes[norm_(r[0])] || []).push({ store: r[1], listing: r[2], price: num_(r[3]), status: r[4], url: r[5], note: r[6] });
    });
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
        description: c ? clip_(c[12], 900) : '', descriptionCut: !!c && String(c[12]).length > 900,
        offers: (offers[id] || []).sort((a, b) => (a.price || 1e9) - (b.price || 1e9)),
        extras: extras[norm_(r[0])] || [],
        fakes: (fakes[norm_(r[0])] || []).sort((a, b) => (b.inStock - a.inStock) || ((a.price || 1e9) - (b.price || 1e9)))
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

/* ------------------------------------------------------------------ registration (USERS tab) */

function regRows_() {
  const sh = tab_(TAB_REG, REG_HEAD);
  const n = sh.getLastRow();
  return { sh: sh, rows: n > 1 ? sh.getRange(2, 1, n - 1, REG_HEAD.length).getValues() : [] };
}

function profile_(user, touch) {
  const r = regRows_();
  const i = r.rows.findIndex(x => String(x[0]).toLowerCase() === user.email);
  if (i >= 0) {
    if (touch) r.sh.getRange(i + 2, 5).setValue(new Date());
    return { name: r.rows[i][1], username: r.rows[i][2], joined: r.rows[i][3] instanceof Date ? r.rows[i][3].toISOString() : String(r.rows[i][3]) };
  }
  if (user.isAdmin) {   // the owner never has to sign up
    const name = String(user.name || user.email.split('@')[0]);
    const uname = user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'owner';
    r.sh.appendRow([user.email, name, uname, new Date(), new Date()]);
    return { name: name, username: uname };
  }
  return null;
}

function register_(user, name, username) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  username = String(username || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 40) throw new Error('Display name must be 2–40 characters');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Username: 3–20 letters, numbers or _');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const r = regRows_();
    if (r.rows.some(x => String(x[0]).toLowerCase() === user.email)) throw new Error('You are already registered');
    if (r.rows.some(x => String(x[2]).toLowerCase() === username)) throw new Error('That username is taken');
    r.sh.appendRow([user.email, name, username, new Date(), new Date()]);
  } finally { lock.releaseLock(); }
  return getMine_(user, false);
}

function requireReg_(user) {
  if (!user.isAdmin && !profile_(user, false)) throw new Error('Please finish signing up first');
  return user;
}

/* ------------------------------------------------------------------ personal data */

function getMine_(user, touch) {
  const prof = profile_(user, !!touch);
  if (!prof) return { email: user.email, name: user.name, isAdmin: false, registered: false, items: {} };
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
      const w = Math.max(6, Math.min(os.getMaxColumns(), OWNED_EDITION_COL));
      os.getRange(2, 1, os.getLastRow() - 1, w).getDisplayValues().forEach(r => {
        const name = String(r[0]).trim();
        if (!name) return;
        const it = items[name] = items[name] || {};
        it.authenticity = r[2]; it.pricePaid = num_(r[3]); it.rating = num_(r[4]); it.plays = num_(r[5]);
        it.edition = r[OWNED_EDITION_COL - 1] || '';
      });
    }
  } else {
    const sh = tab_(TAB_USERS, USER_HEAD);
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, USER_HEAD.length).getValues().forEach(r => {
        if (String(r[0]).toLowerCase() !== user.email) return;
        items[r[1]] = { status: r[2], interest: r[3], since: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || ''), authenticity: r[5], pricePaid: num_(r[6]),
          rating: num_(r[7]), plays: num_(r[8]), notes: r[9], edition: r[11] || '' };
      });
    }
  }
  return { email: user.email, name: prof.name || user.name, username: prof.username, isAdmin: user.isAdmin, registered: true, items: items };
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
  if ('edition' in f) o.edition = String(f.edition || '').slice(0, 80);
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
  const personal = ['authenticity', 'pricePaid', 'rating', 'plays', 'edition'].some(k => k in f);
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
  if ('edition' in f) { ensureOwnedEdition_(os); os.getRange(row, OWNED_EDITION_COL).setValue(f.edition); }
}

function ensureOwnedEdition_(os) {
  if (os.getMaxColumns() < OWNED_EDITION_COL) os.insertColumnsAfter(os.getMaxColumns(), OWNED_EDITION_COL - os.getMaxColumns());
  const h = os.getRange(1, OWNED_EDITION_COL);
  if (!h.getDisplayValue()) h.setValue('EDITION').setFontWeight('bold');
}

function saveUser_(user, name, f) {
  const sh = tab_(TAB_USERS, USER_HEAD);
  const n = sh.getLastRow();
  const v = n > 1 ? sh.getRange(2, 1, n - 1, USER_HEAD.length).getValues() : [];
  let i = v.findIndex(r => String(r[0]).toLowerCase() === user.email && norm_(r[1]) === norm_(name));
  const row = i >= 0 ? v[i] : [user.email, name, '', '', '', '', '', '', '', '', '', ''];
  while (row.length < USER_HEAD.length) row.push('');
  const map = { status: 2, interest: 3, authenticity: 5, pricePaid: 6, rating: 7, plays: 8, notes: 9, edition: 11 };
  for (const k in f) row[map[k]] = f[k];
  if ('interest' in f) row[4] = f.interest ? new Date() : '';
  row[10] = new Date();
  if (i >= 0) sh.getRange(i + 2, 1, 1, USER_HEAD.length).setValues([row]);
  else sh.appendRow(row);
}

/* ------------------------------------------------------------------ BGG + BGFinder */

// BGG asks for about 5 s between requests. 202 = queued (ask again later); 429/500/503 = slow down.
const BGG_PAUSE_MS = 5000;
const BGG_BATCH = 20;   // max ids per /thing request

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

/** One request for up to 20 games. Returns { id: details } (no store data). */
function bggThings_(ids) {
  const root = bggFetch_('thing?stats=1&id=' + ids.join(','));
  const out = {};
  if (root) root.getChildren('item').forEach(item => { const d = bggItem_(item); out[d.id] = d; });
  return out;
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
  if (item) d = bggItem_(item);
  return withStores_(d, id, bgfCache);
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
  return {
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

/** Adds India store listings (and falls back to BGFinder's copy of the BGG data when there is no token). */
function withStores_(d, id, bgfCache) {
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

/** Shortens text at a word boundary (BGG's text itself is not changed; the page links to the full version). */
function clip_(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 40)).replace(/[\s,;:.]+$/, '');
}

function decode_(s) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
    mdash: '—', ndash: '–', hellip: '…', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', times: '×', bull: '•' };
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] || m);
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

function cacheRow_(id, d) {
  return [id, d.name || '', d.year || '', d.image || '', d.thumb || '', d.rating || '', d.rank || '', d.weight || '',
    (d.mechanics || []).join('|'), (d.categories || []).join('|'), (d.designers || []).join('|'), d.bestPlayers || '',
    String(d.description || '').slice(0, 5000), new Date()];
}

/** Upserts many BGG_CACHE rows with one read and one write. Keeps existing rank/rating when the new data has none. */
function writeCacheBulk_(pairs) {
  if (!pairs.length) return;
  const sh = tab_(TAB_CACHE, CACHE_HEAD);
  const n = sh.getLastRow();
  const data = n > 1 ? sh.getRange(2, 1, n - 1, CACHE_HEAD.length).getValues() : [];
  const at = {};
  data.forEach((r, i) => at[String(r[0])] = i);
  pairs.forEach(([id, d]) => {
    const row = cacheRow_(id, d);
    if (id in at) {
      const old = data[at[id]];
      data[at[id]] = row.map((v, k) => (v === '' || v == null) ? old[k] : v);
    } else { at[id] = data.length; data.push(row); }
  });
  sh.getRange(2, 1, data.length, CACHE_HEAD.length).setValues(data);
}

function writeCache_(id, d) {
  const sh = tab_(TAB_CACHE, CACHE_HEAD);
  const row = [id, d.name || '', d.year || '', d.image || '', d.thumb || '', d.rating || '', d.rank || '', d.weight || '',
    (d.mechanics || []).join('|'), (d.categories || []).join('|'), (d.designers || []).join('|'), d.bestPlayers || '',
    String(d.description || '').slice(0, 5000), new Date()];
  const n = sh.getLastRow();
  const ids = n > 1 ? sh.getRange(2, 1, n - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const i = ids.indexOf(id);
  if (i >= 0) sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

/* ------------------------------------------------------------------ SUMMARY tab (owner only: it holds owned / spent data) */

function readSummary_() {
  const sh = ss_().getSheetByName('SUMMARY');
  if (!sh) return { grid: [] };
  const grid = sh.getDataRange().getDisplayValues();
  while (grid.length && grid[grid.length - 1].every(c => !String(c).trim())) grid.pop();
  return { grid: grid };
}

/* ------------------------------------------------------------------ first-run self setup */

/** Runs setup() once, automatically, the first time the site asks for the catalogue. */
function ensureSetup_() {
  const p = props_();
  if (p.getProperty('SETUP_V2')) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;            // someone else is already setting up
  try {
    if (!p.getProperty('SETUP_V1')) { setup(); p.setProperty('SETUP_V1', new Date().toISOString()); }
    if (!p.getProperty('SETUP_V2')) { setupV2_(); p.setProperty('SETUP_V2', new Date().toISOString()); bustCache_(); }
  } catch (e) {
    Logger.log('Auto setup failed: ' + e.message);
  } finally { lock.releaseLock(); }
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
  const token = !!props_().getProperty('BGG_TOKEN');
  const bgf = bgfRows_();
  const onBgf = {};
  bgf.forEach(r => onBgf[String(r[0])] = 1);
  // Without a token: skip games that already have art, or that no source can give art for yet.
  // With a token: skip only games already filled from BGG itself (they have the "best players" poll).
  if (cs.getLastRow() > 1) cs.getRange(2, 1, cs.getLastRow() - 1, 12).getDisplayValues().forEach(r => {
    if (token ? (r[3] && r[11]) : (r[3] || !onBgf[r[0]])) have[r[0]] = 1;
  });
  const need = [];
  for (const t in CAT_TABS) {
    const sh = ss.getSheetByName(t);
    if (sh) rowsOf_(sh).forEach(x => { const id = bggId_(x.r[COL.BGG - 1]); if (id && !have[id] && need.indexOf(id) < 0) need.push(id); });
  }
  const started = Date.now();
  const fresh = [];
  if (token) {
    // 20 games per request, 5 s apart (BGG's guidance); about 2 minutes for 450 games.
    for (let i = 0; i < need.length && Date.now() - started < 240000; i += BGG_BATCH) {
      const got = bggThings_(need.slice(i, i + BGG_BATCH));
      Object.keys(got).forEach(id => fresh.push([id, got[id]]));
      Utilities.sleep(BGG_PAUSE_MS);
    }
  } else {
    need.forEach(id => {
      if (Date.now() - started > 240000) return;   // stay under the 6 min limit; the next run does the rest
      try { fresh.push([id, bggDetails_(id, bgf)]); } catch (e) { /* not on BGFinder and no token yet */ }
    });
  }
  writeCacheBulk_(fresh);
  bustCache_();
  Logger.log('Cached ' + need.length + ' games');
}

/** Rank, rating and year for every game from the public daily BGG ranks file (no token needed). */
function refreshRanks() {
  let csv = '';
  for (let back = 0; back < 4 && !csv; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const r = UrlFetchApp.fetch(RANKS_REPO + Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd') + '.csv', { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) csv = r.getContentText();
  }
  if (!csv) return 0;
  const want = {};
  sheetGames_().forEach(g => { if (g.id) want[g.id] = g.name; });
  const rows = Utilities.parseCsv(csv);
  const pairs = [];
  rows.slice(1).forEach(r => {
    if (want[r[0]]) pairs.push([r[0], { name: r[1], year: r[2], rank: r[3], rating: (+r[4]).toFixed(2), thumb: '' }]);
  });
  writeCacheBulk_(pairs);
  return pairs.length;
}

function sheetGames_() {
  const ss = ss_(), out = [];
  for (const t in CAT_TABS) {
    const sh = ss.getSheetByName(t);
    if (sh) rowsOf_(sh).forEach(x => out.push({ name: String(x.r[0]).trim(), id: bggId_(x.r[COL.BGG - 1]), sh: sh, row: x.row, r: x.r }));
  }
  return out;
}

/** Counterfeit / budget sellers: reads their public Shopify product lists and keeps the listings that match our games. */
function refreshCounterfeit() {
  const sh = ss_().getSheetByName(TAB_FAKE);
  if (!sh || sh.getLastRow() < 2) return 0;
  const stores = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().filter(r => r[0] && r[1]);
  const games = sheetGames_().map(g => ({ name: g.name, key: ' ' + normT_(g.name) + ' ' }));
  const VARIANT = /\b(expansion|extension|mini|junior|kids|pocket|travel|first journey|damage|damaged|sleeves?|insert|organi[sz]er|playmat|promo|booster|refill|replacement|puzzle|jigsaw|keychain|t shirt|poster)\b/;
  const GENERIC = { '': 1, board: 1, card: 1, game: 1, games: 1, strategy: 1, party: 1, family: 1, the: 1, by: 1, from: 1, english: 1, hindi: 1, edition: 1, original: 1, classic: 1, base: 1, core: 1, new: 1, deluxe: 1, cooperative: 1, a: 1, award: 1, trade: 1, '2': 1 };
  const out = [], now = new Date();
  stores.forEach(([store, site]) => {
    let host;
    try { host = site.match(/^https?:\/\/([^/]+)/)[1]; } catch (e) { return; }
    const products = [];
    for (let page = 1; page <= 40; page++) {
      const r = UrlFetchApp.fetch('https://' + host + '/products.json?limit=250&page=' + page, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 board-game-shelf' } });
      if (r.getResponseCode() !== 200) break;
      let list;
      try { list = JSON.parse(r.getContentText()).products || []; } catch (e) { break; }
      if (!list.length) break;
      list.forEach(p => products.push({ title: p.title, key: ' ' + normT_(p.title) + ' ', handle: p.handle,
        price: +(p.variants && p.variants[0] && p.variants[0].price || 0), inStock: (p.variants || []).some(v => v.available) }));
    }
    games.forEach(g => {
      const hits = products.filter(p => {
        const i = p.key.indexOf(g.key);
        if (i < 0) return false;
        const extra = p.key.replace(g.key, ' ');
        if (VARIANT.test(extra) && !VARIANT.test(g.key)) return false;
        const next = p.key.slice(i + g.key.length).trim().split(' ')[0] || '';
        const short = g.key.trim().split(' ').length === 1 && g.key.trim().length <= 6;
        return !short || GENERIC[next];
      }).sort((a, b) => (b.inStock - a.inStock) || (a.price - b.price)).slice(0, 3);
      hits.forEach(p => out.push([g.name, store, p.title, p.price, p.inStock, 'https://' + host + '/products/' + p.handle, now]));
    });
  });
  const fs = tab_(TAB_FAKE_PRICES, FAKE_HEAD);
  if (fs.getLastRow() > 1) fs.getRange(2, 1, fs.getLastRow() - 1, FAKE_HEAD.length).clearContent();
  if (out.length) fs.getRange(2, 1, out.length, FAKE_HEAD.length).setValues(out);
  bustCache_();
  return out.length;
}

function normT_(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** With a BGG token: finds missing BGG ids by exact name and fills blank players / time / age / weight / genre / tags. */
function fillFromBgg() {
  if (!props_().getProperty('BGG_TOKEN')) return 0;
  const started = Date.now();
  let done = 0;
  sheetGames_().forEach(g => {
    if (Date.now() - started > 240000) return;
    const blanks = [1, 2, 3, 4, 5, 6, 7, 8].filter(i => !String(g.r[i]).trim());
    if (g.id && !blanks.length) return;
    try {
      let id = g.id;
      if (!id) {
        const hit = bggSearch_(g.name).find(h => normT_(h.name) === normT_(g.name));
        Utilities.sleep(BGG_PAUSE_MS);
        if (!hit) return;
        id = hit.id;
        g.sh.getRange(g.row, COL.BGG).setValue('https://boardgamegeek.com/boardgame/' + id);
      }
      const d = bggDetails_(id);
      const vals = { 1: d.minP, 2: d.maxP, 3: d.minT, 4: d.maxT, 5: d.age, 6: d.weight, 7: d.suggest.genre, 8: d.suggest.tags };
      blanks.forEach(i => { if (vals[i] !== '' && vals[i] != null) g.sh.getRange(g.row, i + 1).setValue(vals[i]); });
      writeCacheBulk_([[id, d]]);
      done++;
      Utilities.sleep(BGG_PAUSE_MS);
    } catch (e) { Logger.log(g.name + ': ' + e.message); }
  });
  bustCache_();
  return done;
}

/** First run only: copies the starter list of expansions / editions / accessories into the EXTRAS tab. */
function seedExtras_() {
  seedTab_(TAB_EXTRAS, EXTRAS_HEAD, EXTRAS_SEED_URL);
  seedTab_(TAB_FAKE_LIST, FAKE_LIST_HEAD, FAKE_LIST_SEED_URL);
}

/** Fills an empty tab from a JSON file on the website (first row = header). Never overwrites your edits. */
function seedTab_(name, head, url) {
  const sh = tab_(name, head);
  if (!sh.getRange(1, 1).getDisplayValue()) sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (sh.getLastRow() > 1) return;
  const r = UrlFetchApp.fetch(url + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return;
  const rows = JSON.parse(r.getContentText()).slice(1).map(x => head.map((_, i) => x[i] == null ? '' : x[i]));
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
}

function nightly() {
  const steps = [refreshBgfinder, fillBggCache, refreshRanks, fillFromBgg, refreshCounterfeit];
  steps.forEach(fn => { try { fn(); } catch (e) { Logger.log(fn.name + ': ' + e.message); } });
  bustCache_();
}

/** Quick part of the v2 upgrade (runs inside a page request); the slow refresh is scheduled a minute later. */
function setupV2_() {
  seedExtras_();
  const os = ss_().getSheetByName(OWNED_TAB);
  if (os) ensureOwnedEdition_(os);
  const ud = tab_(TAB_USERS, USER_HEAD);
  if (!ud.getRange(1, USER_HEAD.length).getDisplayValue()) ud.getRange(1, USER_HEAD.length).setValue('EDITION').setFontWeight('bold');
  const fake = tab_(TAB_FAKE, ['STORE', 'WEBSITE', 'SEARCH URL ({q} = game name)']);
  const names = fake.getLastRow() > 1 ? fake.getRange(2, 1, fake.getLastRow() - 1, 1).getDisplayValues().map(r => r[0].toLowerCase()) : [];
  if (names.indexOf('funkky') < 0) fake.appendRow(['Funkky', '', '']);
  tab_(TAB_FAKE_PRICES, FAKE_HEAD);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'nightly').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(4).create();
  ScriptApp.newTrigger('nightly').timeBased().after(60 * 1000).create();
}

/** Run once from the editor. Creates the helper tabs, adds ALSO IN, schedules a nightly refresh. */
function setup() {
  Object.keys(CAT_TABS).forEach(t => { const sh = ss_().getSheetByName(t); if (sh) ensureAlsoCol_(sh); });
  tab_(TAB_CACHE, CACHE_HEAD);
  tab_(TAB_BGF, BGF_HEAD);
  tab_(TAB_USERS, USER_HEAD);
  tab_(TAB_REG, REG_HEAD);
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
  props_().setProperty('SETUP_V1', new Date().toISOString());
  setupV2_();
  props_().setProperty('SETUP_V2', new Date().toISOString());
  nightly();
}
