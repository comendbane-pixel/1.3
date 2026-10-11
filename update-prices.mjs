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
const MAX_PAGES = Number(process.env.MAX_PAGES) || 25;  // 25 pages x 3 crédits = 75 crédits
const MIN_RATING = Number(process.env.MIN_RATING ?? 80);
const SNAPSHOT_SIZE = Number(process.env.SNAPSHOT_SIZE ?? 500); // 500 maximum
const HISTORY_MAX = 14;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 150000); // parse.bot peut être lent (1 minute par page)
const RETRY_MS = Number(process.env.RETRY_MS ?? 30000);      // pause avant un nouvel essai
const MAX_TRIES = Number(process.env.MAX_TRIES ?? 4);        // essais par requête
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

const POS_RE = /LWB|RWB|GK|CB|LB|RB|CDM|CAM|CM|LM|RM|LW|RW|CF|ST|LF|RF|LS|RS/g;
function cleanPos(p) {
  if (p === undefined || p === null) return '';
  const parts = String(p).toUpperCase().match(POS_RE);
  if (parts && parts.length) return [...new Set(parts)].join(', ');
  return String(p).replace(/\+/g, '').trim();
}

// Toutes les adresses d'image d'un joueur, même rangées dans des sous-objets : [chemin, adresse]
const IMG_RE = /^https?:\/\/\S+/i;
function imageFields(o, prefix = '', depth = 0, out = []) {
  if (!o || typeof o !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      if (IMG_RE.test(v) && (/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(v) || /\/(img|image|images)\//i.test(v) || /(image|img|photo|face|avatar|portrait|head)/i.test(k))) out.push([path, v]);
    } else if (v && typeof v === 'object') {
      imageFields(v, path, depth + 1, out);
    }
  }
  return out;
}

// Photo du joueur (le visage), pas le fond de carte ni les logos de club / pays.
function findPlayerImage(p, cardImage) {
  const bad = /(\/cards\/|\/clubs?\/|\/nations?\/|\/flags?\/|\/leagues?\/|\/badges?\/|logo)/i;
  const badKey = /(card|club|nation|league|flag|badge|logo|country|team)/i;
  const all = imageFields(p).filter(([, v]) => v !== cardImage && !bad.test(v));
  const byKey = all.find(([k]) => /(player|face|head|photo|avatar|portrait)/i.test(k) && !badKey.test(k));
  if (byKey) return byKey[1];
  const byUrl = all.find(([, v]) => /\/players?\//i.test(v));
  return byUrl ? byUrl[1] : '';
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
  const out = {
    id: String(idRaw),
    name: String(pick(p, ['name', 'player_name', 'full_name', 'common_name', 'commonName']) ?? 'Inconnu'),
    rating: Number.isFinite(rating) ? rating : 0,
    pos: cleanPos(pick(p, ['pos', 'position', 'preferred_position'])),
    club: String(pick(p, ['club', 'club_name', 'team']) ?? ''),
    nation: String(pick(p, ['nation', 'nation_name', 'country']) ?? ''),
    league: String(pick(p, ['league', 'league_name']) ?? ''),
    stats: normStats(p),
    cardImage: String(pick(p, ['cardImage', 'card_image', 'card_image_url', 'card_url', 'image_url', 'image']) ?? ''),
    playerImage: '',
    cardImageLarge: String(pick(p, ['card_image_large_url', 'cardImageLarge', 'card_image_large']) ?? ''),
    playerImageLarge: String(pick(p, ['image_large', 'imageLarge', 'player_image_large']) ?? ''),
    nationImage: String(pick(p, ['nation_image', 'nationImage', 'nation_image_url', 'flag_image']) ?? ''),
    leagueImage: String(pick(p, ['league_image', 'leagueImage', 'league_image_url', 'league_badge']) ?? ''),
    version: String(pick(p, ['version', 'card_type', 'rarity']) ?? ''),
    skillMoves: Number(pick(p, ['skill_moves', 'skillMoves', 'skills'])) || 0,
    weakFoot: Number(pick(p, ['weak_foot', 'weakFoot', 'wf'])) || 0,
    clubImage: String(pick(p, ['club_image', 'clubImage', 'club_image_url', 'badge_image']) ?? ''),
    price: toPrice(pick(p, ['price', 'ps_price', 'current_price', 'lowest_price', 'prices'])),
    history: [],
  };
  out.playerImage = out.playerImageLarge || findPlayerImage(p, out.cardImage);
  // Logos construits à partir des identifiants, si la réponse en contient et qu'il n'y a pas déjà une image.
  const idOf = (keys) => { const v = pick(p, keys); return v !== undefined && v !== null && /^\d+$/.test(String(v)) ? String(v) : ''; };
  const cdn = 'https://cdn.futbin.com/content/fifa27/img/';
  const nid = idOf(['nation_id', 'nationId']), cid = idOf(['club_id', 'clubId']), lid = idOf(['league_id', 'leagueId']);
  if (!out.nationImage && nid) out.nationImage = `${cdn}nation/${nid}.png`;
  if (!out.clubImage && cid) out.clubImage = `${cdn}clubs/${cid}.png`;
  if (!out.leagueImage && lid) out.leagueImage = `${cdn}leaguelogo/${lid}.png`;
  return out;
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

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const last = attempt >= MAX_TRIES;
    lastCall = Date.now();
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (!last) {
        console.log(`${label} : pas de réponse (${e.name}). Nouvel essai dans ${Math.round(RETRY_MS / 1000)} s (essai ${attempt}/${MAX_TRIES}).`);
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
      // Une vraie clé refusée est rejetée en quelques secondes. Un « refus » après ~2 minutes, ou alors que la
      // clé a déjà marché, est en fait un délai dépassé chez parse.bot : on réessaie.
      const timeoutLike = authOK || secs >= 60;
      if (timeoutLike && !last) {
        console.log(`${label} : refus (HTTP ${res.status}) après ${secs} s, probablement un délai dépassé chez parse.bot. Réponse : ${body || '(vide)'}`);
        console.log(`Nouvel essai dans ${Math.round(RETRY_MS / 1000)} s (essai ${attempt}/${MAX_TRIES}).`);
        await sleep(RETRY_MS);
        continue;
      }
      // On écrit seulement la LONGUEUR de la clé, jamais la clé elle-même.
      throw new Error(
        `${label} : accès refusé (HTTP ${res.status}) après ${secs} s. ` +
        `Réponse de parse.bot : ${body || '(vide)'}. ` +
        `La clé reçue par le robot fait ${KEY.length} caractères. ` +
        (secs < 60 && !authOK
          ? `Refus immédiat : la clé est sans doute fausse. Teste-la avec « Send request » sur parse.bot, puis vérifie le secret PARSE_API_KEY.`
          : `Refus lent : parse.bot n'arrive pas à répondre à temps. Réessaie plus tard, la clé semble bonne.`)
      );
    }
    if (res.status === 429 && !last) {
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
  throw new Error(`${label} : échec après ${MAX_TRIES} essais`);
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
  for (const k of ['name', 'pos', 'club', 'nation', 'league', 'cardImage', 'playerImage', 'cardImageLarge', 'playerImageLarge', 'nationImage', 'clubImage', 'leagueImage', 'skillMoves', 'weakFoot', 'version', 'cardName']) {
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
  const restart = process.env.RESTART === '1'; // test : repart de la page 1 sans toucher au point de reprise
  let start = Number.isInteger(data.listNext) && data.listNext > 0 && !restart ? data.listNext : 1;
  let total = 0;
  let finished = false;
  for (let page = start; page < start + MAX_PAGES; page++) {
    console.log(`Catalogue : page ${page} (${page - start + 1}/${MAX_PAGES} de ce passage)`);
    let payload;
    try {
      payload = await api('list_fc27_players', {
        platform: 'ps', min_rating: MIN_RATING, sort_by_price: 'desc', page,
      }, 'list_fc27_players');
    } catch (e) {
      if (!total) throw e;
      // Des pages sont déjà enregistrées : on s'arrête proprement, rien n'est perdu.
      console.log(`ATTENTION : ${e.message}`);
      console.log(`Arrêt propre : ${total} cartes enregistrées dans ce passage. Relance le mode « list » pour reprendre à la page ${page}.`);
      return;
    }
    const raw = toArray(payload);
    if (page === start && raw[0] && typeof raw[0] === 'object') {
      console.log('Champs reçus pour un joueur : ' + Object.keys(raw[0]).join(', '));
      const imgs = imageFields(raw[0]);
      console.log('Champs contenant une adresse d\'image : ' + (imgs.length ? imgs.map(([k, v]) => `${k} = ${v.slice(0, 110)}`).join(' | ') : 'aucun'));
    }
    const arr = raw.map(normPlayer).filter(Boolean);
    if (page === start && arr[0]) console.log('Photo du joueur trouvée : ' + (arr[0].playerImage ? 'oui' : 'non'));
    if (page === start && arr[0]) console.log('Logos trouvés : pays ' + (arr[0].nationImage ? 'oui' : 'non') + ' | ligue ' + (arr[0].leagueImage ? 'oui' : 'non') + ' | club ' + (arr[0].clubImage ? 'oui' : 'non'));
    if (page === start && arr[0]) console.log('Image de carte HD trouvée : ' + (arr[0].cardImageLarge ? 'oui' : 'non') + ' | photo HD : ' + (arr[0].playerImageLarge ? 'oui' : 'non'));
    if (!arr.length) { console.log('Page vide : fin du catalogue.'); finished = true; break; }
    for (const c of arr) mergeCard(map, c, now);
    total += arr.length;
    data.cards = [...map.values()];
    data.updatedAt = new Date(now).toISOString();
    data.source = 'FUTBIN via parse.bot';
    if (!restart) data.listNext = page + 1;
    await saveData(data); // sauvegarde à chaque page : rien n'est perdu si ça s'arrête
  }
  if (finished && !restart) { data.listNext = null; await saveData(data); }
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


// ---------- styles de jeu (PlayStyles) ----------
// Une requête par joueur : coût en crédits inconnu, donc on en demande peu (DETAILS_COUNT) et on affiche ce que ça coûte.
async function modeDetails(data) {
  if (!data.cards.length) throw new Error('data.json est vide : lance d\'abord le mode « list ».');
  const count = Math.max(1, Math.min(Number(process.env.DETAILS_COUNT) || 3, 40));
  const wanted = String(process.env.DETAILS_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const byId = new Map(data.cards.map((c) => [c.id, c]));
  let chosen;
  if (wanted.length) chosen = wanted.map((i) => byId.get(i)).filter(Boolean);
  else chosen = data.cards.filter((c) => !c.ps).sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, count);
  const names = (process.env.DETAILS_ENDPOINT ? [process.env.DETAILS_ENDPOINT] : ['get_fc27_player_details', 'get_player_details']);
  let endpoint = null, done = 0;
  for (const c of chosen) {
    let payload = null;
    for (const ep of (endpoint ? [endpoint] : names)) {
      try { payload = await api(ep, { player_id: c.id }, ep); endpoint = ep; break; }
      catch (e) { console.log(`${ep} : ${e.message}`); }
    }
    if (!payload) continue;
    const root = Array.isArray(payload) ? payload[0] : (payload.data || payload.player || payload);
    if (done === 0) {
      console.log('Champs reçus (détails) : ' + Object.keys(root || {}).join(', '));
      for (const [k, v] of Object.entries(root || {})) {
        if (Array.isArray(v) && v[0] && typeof v[0] === 'object') console.log(`  ${k}[0] : ` + Object.keys(v[0]).join(', '));
      }
    }
    const list = (root && (root.playstyles || root.play_styles || root.playStyles)) || [];
    const ps = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || typeof x !== 'object') continue;
      const logo = pick(x, ['logo', 'image', 'icon', 'image_url']);
      const name = pick(x, ['name', 'title', 'label']);
      if (!logo && !name) continue;
      const l = logo ? String(logo) : '';
      const gold = x.plus === true || x.is_plus === true || x.type === 'plus' || /\/plus\//i.test(l) || /\+\s*$/.test(String(name || ''));
      ps.push({ n: name ? String(name) : '', l, g: gold });
    }
    c.ps = ps;
    done++;
    console.log(`${c.name} : ${ps.length} style(s) de jeu (${ps.filter((p) => p.g).length} doré(s)).`);
    await saveData(data);
  }
  if (!done) throw new Error('Aucun détail reçu : le nom du point d\'accès est peut-être différent (voir les messages ci-dessus).');
  console.log(`Détails enregistrés pour ${done} joueur(s). Regarde ton solde de crédits sur parse.bot pour connaître le prix d'une requête.`);
}

// ---------- fiche complète (nom de carte + logos) ----------
// get_fc27_player_price : une requête par joueur, coût inconnu → petit nombre par défaut.
async function modeFiche(data) {
  if (!data.cards.length) throw new Error('data.json est vide : lance d\'abord le mode « list ».');
  const count = Math.max(1, Math.min(Number(process.env.DETAILS_COUNT) || 3, 40));
  const chosen = data.cards.filter((c) => !c.cardName).sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, count);
  let done = 0;
  for (const c of chosen) {
    let payload;
    try { payload = await api('get_fc27_player_price', { player_id: c.id }, 'get_fc27_player_price'); }
    catch (e) { console.log(`${c.name} : ${e.message}`); continue; }
    const root = Array.isArray(payload) ? payload[0] : (payload && (payload.data || payload.player) || payload);
    if (!root || typeof root !== 'object') continue;
    if (done === 0) console.log('Champs reçus (fiche) : ' + Object.keys(root).join(', '));
    const n = pick(root, ['name', 'card_name']);
    if (n) c.cardName = String(n);
    const f = normPlayer({ ...root, id: c.id, player_id: c.id });
    for (const k of ['nationImage', 'clubImage', 'leagueImage']) if (f && f[k]) c[k] = f[k];
    done++;
    console.log(`${c.name} → carte « ${c.cardName || '?'} » | pays ${c.nationImage ? 'oui' : 'non'} | ligue ${c.leagueImage ? 'oui' : 'non'} | club ${c.clubImage ? 'oui' : 'non'}`);
    await saveData(data);
  }
  if (!done) throw new Error('Aucune fiche reçue (voir les messages ci-dessus).');
  console.log(`Fiches enregistrées : ${done}. Regarde ton solde de crédits sur parse.bot pour connaître le prix d'une requête.`);
}

// ---------- départ ----------
async function main() {
  if (!KEY) {
    console.error('La variable PARSE_API_KEY est vide. Crée le secret PARSE_API_KEY dans Settings → Secrets and variables → Actions.');
    process.exit(1);
  }
  let mode = (process.argv[2] || process.env.MODE || 'auto').trim().toLowerCase();
  if (!['auto', 'list', 'snapshot', 'details', 'fiche'].includes(mode)) mode = 'auto';
  const data = await loadData();
  if (mode === 'auto') mode = data.cards.length ? 'snapshot' : 'list';
  console.log(`Mode : ${mode}`);
  if (mode === 'list') await modeList(data);
  else if (mode === 'fiche') await modeFiche(data);
  else if (mode === 'details') await modeDetails(data);
  else await modeSnapshot(data);
  console.log('Terminé.');
}

main().catch((e) => {
  console.error('ERREUR :', e.message);
  process.exit(1);
});
