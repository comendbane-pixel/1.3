// update-prices.mjs — récupère les prix FC 27 via parse.bot et met à jour data.json
// Node 20, aucune dépendance. La clé vient UNIQUEMENT de la variable PARSE_API_KEY.
//
// Utilisation :  node update-prices.mjs [auto|list|snapshot]
//   auto     : "list" si data.json est vide, sinon "snapshot"
//   list     : remplit le catalogue (3 crédits par page)
//   snapshot : met à jour les prix (10 crédits) + SBC en cours (1 crédit)

import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(DIR, 'data.json');

const BASE = (process.env.API_BASE ||
  'https://api.parse.bot/scraper/f56a52f1-08bd-4926-8246-945dc47bce4e').replace(/\/+$/, '');
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 13000); // 5 requêtes/minute max
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 25);  // 25 pages x 3 crédits = 75 crédits
const MIN_RATING = Number(process.env.MIN_RATING ?? 80);
const SNAPSHOT_SIZE = Number(process.env.SNAPSHOT_SIZE ?? 500); // 500 maximum
const HISTORY_MAX = 14;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 150000); // parse.bot peut être lent (1 minute par page)
const RETRY_MS = Number(process.env.RETRY_MS ?? 30000);      // pause avant un 2e essai
let authOK = false; // devient vrai dès qu'une requête a réussi

// ---------- clé ----------
// On enlève les espaces, retours à la ligne et guillemets collés par erreur.
const KEY = String(process.env.PARSE_API_KEY || '')
  .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
  .replace(/\s+/g, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- outils tolérants ----------
const pick = (o, keys) => {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
};

function toPrice(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    // ex. { ps: 12000 } ou { price: 12000 }
    return toPrice(pick(v, ['ps', 'price', 'value', 'current', 'lowest']));
  }
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  const s = String(v).trim().toUpperCase().replace(/[\s, ]/g, '');
  let n;
  if (/^[\d.]+K$/.test(s)) n = parseFloat(s) * 1000;
  else if (/^[\d.]+M$/.test(s)) n = parseFloat(s) * 1000000;
  else n = parseInt(s.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function toArray(payload) {
  // Les réponses sont rangées sous « data », mais on reste prudent.
  let d = payload && payload.data !== undefined ? payload.data : payload;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['players', 'items', 'results', 'sbcs', 'snapshot', 'prices', 'list', 'data']) {
      if (Array.isArray(d[k])) return d[k];
    }
    // objet { id: prix }
    const vals = Object.values(d);
    if (vals.length && vals.every((v) => typeof v === 'object' || typeof v === 'number' || v === null)) {
      if (Object.keys(d).every((k) => /^\d+$/.test(k))) {
        return Object.entries(d).map(([id, v]) =>
          typeof v === 'object' && v !== null ? { player_id: id, ...v } : { player_id: id, price: v });
      }
    }
  }
  return [];
}

function cleanPos(p) {
  if (p === undefined || p === null) return '';
  return String(p).replace(/\+/g, '').trim();
}

function normStats(p) {
  const s = (p && typeof p.stats === 'object' && p.stats) || {};
  const get = (long, short, alt) => {
    const v = pick(s, [short, short.toLowerCase(), long, alt]) ?? pick(p, [short, short.toLowerCase(), long, alt]);
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? n : null;
  };
  return {
    PAC: get('pace', 'PAC', 'Pace'),
    SHO: get('shooting', 'SHO', 'Shooting'),
    PAS: get('passing', 'PAS', 'Passing'),
    DRI: get('dribbling', 'DRI', 'Dribbling'),
    DEF: get('defending', 'DEF', 'Defending'),
    PHY: get('physical', 'PHY', 'Physical'),
  };
}

function normPlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const idRaw = pick(p, ['id', 'player_id', 'playerId', 'futbin_id', 'resource_id']);
  if (idRaw === undefined) return null;
  const rating = Number(pick(p, ['rating', 'overall', 'ovr']));
  return {
    id: String(idRaw),
    name: String(pick(p, ['name', 'player_name', 'full_name', 'common_name', 'commonName']) ?? 'Inconnu'),
    rating: Number.isFinite(rating) ? rating : 0,
    pos: cleanPos(pick(p, ['pos', 'position', 'preferred_position'])),
    club: String(pick(p, ['club', 'club_name', 'team']) ?? ''),
    nation: String(pick(p, ['nation', 'nation_name', 'country']) ?? ''),
    league: String(pick(p, ['league', 'league_name']) ?? ''),
    stats: normStats(p),
    cardImage: String(pick(p, ['cardImage', 'card_image', 'card_image_url', 'card_url', 'image_url', 'image']) ?? ''),
    price: toPrice(pick(p, ['price', 'ps_price', 'current_price', 'lowest_price', 'prices'])),
    history: [],
  };
}

// ---------- appels API ----------
let lastCall = 0;
async function api(endpoint, params = {}, label = endpoint) {
  const wait = lastCall + PAUSE_MS - Date.now();
  if (lastCall && wait > 0) await sleep(wait);

  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    lastCall = Date.now();
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt === 1) {
        console.log(`${label} : pas de réponse (${e.name}). Nouvel essai dans ${Math.round(RETRY_MS / 1000)} s.`);
        await sleep(RETRY_MS);
        continue;
      }
      throw new Error(`${label} : impossible de joindre parse.bot (${e.message})`);
    }
    if (res.status === 401 || res.status === 403) {
      // parse.bot explique souvent la raison dans sa réponse : on l'affiche (sans jamais afficher la clé).
      let body = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
      if (KEY) body = body.split(KEY).join('***');
      const secs = Math.round((Date.now() - lastCall) / 1000);
      if (attempt === 1) {
        console.log(`${label} : refus (HTTP ${res.status}) après ${secs} s. Réponse de parse.bot : ${body || '(vide)'}`);
        console.log(`Nouvel essai dans ${Math.round(RETRY_MS / 1000)} s.`);
        await sleep(RETRY_MS);
        continue;
      }
      // On écrit seulement la LONGUEUR de la clé, jamais la clé elle-même.
      throw new Error(
        `${label} : accès refusé (HTTP ${res.status}) après ${secs} s. ` +
        `Réponse de parse.bot : ${body || '(vide)'}. ` +
        `La clé reçue par le robot fait ${KEY.length} caractères. ` +
        `Teste-la d'abord avec « Send request » sur parse.bot, puis vérifie le secret PARSE_API_KEY.`
      );
    }
    if (res.status === 429 && attempt === 1) {
      console.log(`${label} : trop de requêtes, pause de 60 s puis nouvel essai.`);
      await sleep(60000);
      continue;
    }
    if (!res.ok) {
      const txt = (await res.text().catch(() => '')).slice(0, 200).replace(KEY || '\u0000', '***');
      throw new Error(`${label} : erreur HTTP ${res.status} ${txt}`);
    }
    authOK = true;
    return res.json();
  }
  throw new Error(`${label} : échec après nouvel essai`);
}

// ---------- data.json ----------
async function loadData() {
  try {
    const d = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    if (!Array.isArray(d.cards)) d.cards = [];
    if (!Array.isArray(d.sbcs)) d.sbcs = [];
    return d;
  } catch {
    return { demo: false, updatedAt: null, source: 'En attente', cards: [], sbcs: [] };
  }
}

async function saveData(d) {
  const tmp = DATA_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(d) + '\n', 'utf8');
  await rename(tmp, DATA_FILE); // écriture atomique : jamais de fichier à moitié écrit
}

function addHistory(card, price, now) {
  if (price === null) return;
  const h = Array.isArray(card.history) ? card.history : [];
  const last = h[h.length - 1];
  if (last && last.p === price && now - last.t < 6 * 3600 * 1000) return;
  h.push({ t: now, p: price });
  card.history = h.slice(-HISTORY_MAX);
}

function mergeCard(map, fresh, now) {
  const old = map.get(fresh.id);
  if (!old) {
    addHistory(fresh, fresh.price, now);
    map.set(fresh.id, fresh);
    return;
  }
  // On garde les anciennes infos si la nouvelle réponse n'en a pas.
  for (const k of ['name', 'pos', 'club', 'nation', 'league', 'cardImage']) {
    if (fresh[k]) old[k] = fresh[k];
  }
  if (fresh.rating) old.rating = fresh.rating;
  if (fresh.stats && Object.values(fresh.stats).some((v) => v !== null)) {
    old.stats = { ...old.stats, ...Object.fromEntries(Object.entries(fresh.stats).filter(([, v]) => v !== null)) };
  }
  if (fresh.price !== null) { // prix null = on garde l'ancien
    old.price = fresh.price;
    addHistory(old, fresh.price, now);
  }
}

// ---------- SBC en cours ----------
async function fetchSbcs() {
  try {
    const payload = await api('get_fc27_sbcs_list', {}, 'get_fc27_sbcs_list');
    const arr = toArray(payload);
    const out = [];
    const seen = new Set();
    for (const s of arr) {
      if (!s || typeof s !== 'object') continue;
      const name = pick(s, ['name', 'title', 'sbc_name']);
      if (!name) continue;
      const exp = pick(s, ['expires', 'expiry', 'expires_at', 'expiration', 'expiration_date', 'end_date', 'expiresAt']);
      const key = String(name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: String(name),
        expires: exp !== undefined ? String(exp) : '',
        url: String(pick(s, ['url', 'link', 'sbc_url']) ?? ''),
        reward: String(pick(s, ['reward', 'rewards']) ?? ''),
      });
    }
    return out;
  } catch (e) {
    if (/accès refusé/.test(e.message)) throw e;
    console.warn('SBC non récupérés (on garde les anciens) :', e.message);
    return null;
  }
}

// ---------- modes ----------
async function modeList(data) {
  const map = new Map(data.cards.map((c) => [c.id, c]));
  const now = Date.now();
  // Reprise : si un passage précédent s'est arrêté, on repart de la page suivante (RESTART=1 pour tout reprendre).
  let start = Number.isInteger(data.listNext) && data.listNext > 0 && process.env.RESTART !== '1' ? data.listNext : 1;
  let total = 0;
  let finished = false;
  for (let page = start; page < start + MAX_PAGES; page++) {
    console.log(`Catalogue : page ${page} (${page - start + 1}/${MAX_PAGES} de ce passage)`);
    const payload = await api('list_fc27_players', {
      platform: 'ps', min_rating: MIN_RATING, sort_by_price: 'desc', page,
    }, 'list_fc27_players');
    const arr = toArray(payload).map(normPlayer).filter(Boolean);
    if (!arr.length) { console.log('Page vide : fin du catalogue.'); finished = true; break; }
    for (const c of arr) mergeCard(map, c, now);
    total += arr.length;
    data.cards = [...map.values()];
    data.updatedAt = new Date(now).toISOString();
    data.source = 'FUTBIN via parse.bot';
    data.listNext = page + 1;
    await saveData(data); // sauvegarde à chaque page : rien n'est perdu si ça s'arrête
  }
  if (finished) { data.listNext = null; await saveData(data); }
  console.log(`Catalogue : ${total} cartes lues, ${data.cards.length} au total.`);
  if (!finished && total) console.log('Catalogue pas fini : relance le mode « list » pour continuer à la page suivante.');
  if (!total && !finished) throw new Error('Aucune carte reçue : vérifie la réponse de list_fc27_players.');
}

async function modeSnapshot(data) {
  if (!data.cards.length) throw new Error('data.json est vide : lance d\'abord le mode « list ».');
  const now = Date.now();
  // On met à jour en priorité les cartes dont le prix est le plus ancien (rotation).
  const stale = (c) => (c.history && c.history.length ? c.history[c.history.length - 1].t : 0);
  const chosen = [...data.cards].sort((a, b) => stale(a) - stale(b)).slice(0, Math.min(SNAPSHOT_SIZE, 500));
  const ids = chosen.map((c) => c.id);
  console.log(`Prix : ${ids.length} cartes demandées.`);
  const payload = await api('get_fc27_market_snapshot', { player_ids: ids.join(',') }, 'get_fc27_market_snapshot');
  const arr = toArray(payload);
  const map = new Map(data.cards.map((c) => [c.id, c]));
  let updated = 0, nulls = 0;
  for (const r of arr) {
    const id = pick(r, ['player_id', 'id', 'playerId']);
    if (id === undefined) continue;
    const card = map.get(String(id));
    if (!card) continue;
    const price = toPrice(pick(r, ['price', 'ps_price', 'current_price', 'prices']));
    if (price === null) { nulls++; continue; } // on garde l'ancien prix
    card.price = price;
    addHistory(card, price, now);
    updated++;
  }
  console.log(`Prix : ${updated} mis à jour, ${nulls} sans prix (ancien prix gardé).`);
  if (!arr.length) throw new Error('Réponse vide de get_fc27_market_snapshot.');
  data.cards = [...map.values()];
  data.updatedAt = new Date(now).toISOString();
  data.source = 'FUTBIN via parse.bot';
  await saveData(data);

  const sbcs = await fetchSbcs();
  if (sbcs) {
    data.sbcs = sbcs;
    await saveData(data);
    console.log(`SBC en cours : ${sbcs.length}.`);
  }
}

// ---------- départ ----------
async function main() {
  if (!KEY) {
    console.error('La variable PARSE_API_KEY est vide. Crée le secret PARSE_API_KEY dans Settings → Secrets and variables → Actions.');
    process.exit(1);
  }
  let mode = (process.argv[2] || process.env.MODE || 'auto').trim().toLowerCase();
  if (!['auto', 'list', 'snapshot'].includes(mode)) mode = 'auto';
  const data = await loadData();
  if (mode === 'auto') mode = data.cards.length ? 'snapshot' : 'list';
  console.log(`Mode : ${mode}`);
  if (mode === 'list') await modeList(data);
  else await modeSnapshot(data);
  console.log('Terminé.');
}

main().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
