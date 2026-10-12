// update-prices.mjs — récupère les prix FC 27 via parse.bot et met à jour data.json
// Node 20, aucune dépendance. Les clés viennent UNIQUEMENT des secrets GitHub PARSE_API_KEYS / PARSE_API_KEY.
//
// Utilisation :  node update-prices.mjs [auto|list|snapshot|details|fiche|select|watch]
//   auto     : "list" si data.json est vide, sinon "snapshot"
//   list     : remplit le catalogue (3 crédits par page)
//   snapshot : met à jour les prix (≈10 crédits par paquet de 500 cartes) + SBC en cours
//
// TRAVAIL EN PARALLÈLE : chaque clé est un « ouvrier ». Avec 20 clés, 20 requêtes partent en même temps
// (chaque ouvrier garde sa propre pause entre deux requêtes). Une clé en panne rend sa tâche aux autres.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(DIR, 'data.json');

const BASE = (process.env.API_BASE ||
  'https://api.parse.bot/scraper/f56a52f1-08bd-4926-8246-945dc47bce4e').replace(/\/+$/, '');
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 13000); // pause entre deux requêtes DE LA MÊME clé (5 requêtes/minute max par clé)
const MAX_PAGES = Number(process.env.MAX_PAGES) || 25;  // 25 pages x 3 crédits = 75 crédits
const MIN_RATING = Number(process.env.MIN_RATING) || 80;
const SORT_DIR = process.env.SORT === 'asc' ? 'asc' : 'desc'; // sens du tri par prix du catalogue ; « asc » sert de 2e passage de contrôle
const SNAPSHOT_SIZE = Math.max(1, Math.min(Number(process.env.SNAPSHOT_SIZE) || 500, 500)); // cartes par requête (500 maximum)
const SNAPSHOT_PARTS = Math.max(0, Math.floor(Number(process.env.SNAPSHOT_PARTS) || 0));    // paquets en même temps (0 = autant que d'ouvriers)
const SNAPSHOT_FRESH_MIN = Number(process.env.SNAPSHOT_FRESH_MIN ?? 30);                    // un prix plus récent que ça n'est pas redemandé
const PARALLEL = process.env.PARALLEL !== '0';                                              // PARALLEL=0 : un seul ouvrier à la fois
const MAX_WORKERS = Math.max(1, Number(process.env.MAX_WORKERS) || 50);
const STAGGER_MS = Number(process.env.STAGGER_MS ?? 500);                                   // départ décalé des ouvriers (évite 20 requêtes à la même milliseconde)
const COST = { list_fc27_players: 3, get_fc27_market_snapshot: 10, get_fc27_sbcs_list: 1 }; // crédits par appel : ESTIMATIONS (jamais vérifiées)
const COST_OTHER = Number(process.env.COST_OTHER ?? 3);
const TOTAL_CREDITS = Number(process.env.TOTAL_CREDITS) || 0; // crédits qu'il reste au total sur l'ensemble des clés AU DÉBUT du mois / du comptage (facultatif)
const DEAD_HOURS = Number(process.env.DEAD_HOURS ?? 6);      // une clé marquée vide est ignorée pendant ce nombre d'heures, puis réessayée (un appel refusé ne coûte rien)
const KEY_CREDITS = Number(process.env.KEY_CREDITS) || 0; // crédits de départ communs à toutes les clés sans total propre (facultatif)
const HISTORY_MAX = 14;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 150000); // parse.bot peut être lent (1 minute par page)
const RETRY_MS = Number(process.env.RETRY_MS ?? 30000);      // pause avant un nouvel essai
const STRIKES = Number(process.env.STRIKES ?? 4);            // une clé n'est mise de côté qu'après ce nombre de refus de suite (un seul refus peut être passager)
const MAX_TRIES = Number(process.env.MAX_TRIES ?? 4);        // essais par requête
// ---------- clés ----------
// Une seule clé (secret PARSE_API_KEY) OU plusieurs (secret PARSE_API_KEYS : une clé par ligne, ou séparées par des virgules).
// Le robot utilise la clé n°1 jusqu'à ce qu'elle n'ait plus de crédits, puis passe à la suivante.
// Seul le NUMÉRO de la clé en cours est enregistré (fichier keys-state.json), jamais la clé elle-même.
const cleanKey = (k) => String(k || '').replace(/^[\s"'`]+|[\s"'`]+$/g, '').replace(/\s+/g, '');
// Accepte : l'adresse API complète, l'adresse de la PAGE parse.bot (…/scrapers/ID), l'adresse sans https://, ou juste l'ID du scraper.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function normBase(b) {
  b = String(b || '').replace(/\/+$/, '');
  if (!b) return '';
  const m = new RegExp(UUID, 'i').exec(b);
  if (m && (/^[0-9a-f-]{36}$/i.test(b) || /parse\.bot\/scrapers?\//i.test(b))) return 'https://api.parse.bot/scraper/' + m[0];
  if (/^https?:\/\//i.test(b)) return b;
  if (/^api\.parse\.bot\//i.test(b)) return 'https://' + b;
  return '';
}
// Chaque entrée peut être « CLÉ » (adresse = API_BASE) ou « CLÉ|ADRESSE_DU_SCRAPER » (compte différent, scraper différent).
const ENTRIES = (() => {
  const seen = new Set(), out = [];
  const toks = String(process.env.PARSE_API_KEYS || '').split(/[\s,;]+/).concat(String(process.env.PARSE_API_KEY || ''));
  for (const t of toks) {
    const [k0, b0, c0] = String(t).split('|');
    const k = cleanKey(k0), b = normBase(cleanKey(b0));
    const cr = Number(String(c0 || '').replace(/[^\d]/g, '')) || 0; // crédits de départ de cette clé (facultatif : CLE|ADRESSE|CREDITS)
    if (!k || seen.has(k + '|' + b)) continue;
    seen.add(k + '|' + b); out.push({ k, b, cr });
  }
  return out;
})();
const KEYS = ENTRIES.map((e) => e.k);
const STATE_FILE = path.join(DIR, 'keys-state.json');
const FP = createHash('sha256').update(ENTRIES.map((e) => e.k + '|' + e.b).join('\n')).digest('hex').slice(0, 12);
// Mots qui disent clairement « plus de crédits ». « limit reached » peut n'être qu'un trop-plein de requêtes : on ne le prend pas pour une clé vide si le code est 429.
const CREDIT_STRICT = /credit|quota|insufficient|exhaust|balance|payment/i;
const CREDIT_LOOSE = /limit reached|plan limit/i;
const redact = (t) => KEYS.concat(ENTRIES.map((e) => e.b).filter(Boolean)).reduce((a, k) => a.split(k).join('***'), String(t));
const shortUrl = (u) => String(u).replace(/^https?:\/\//, '').replace(/([0-9a-f]{8})[0-9a-f-]{28}/gi, '$1…');

// ---------- ouvriers : un par clé ----------
// Un ouvrier = une clé + son adresse de scraper + sa propre pause. Il fait une requête à la fois.
class KeyDead extends Error {}
const W = ENTRIES.map((e, i) => ({
  i, k: e.k, b: e.b || BASE, budget: e.cr || KEY_CREDITS || null,
  busy: false, dead: false, why: '', credit: false, keep: false, ok: false, spent: 0, left: null,
  last: Date.now() - PAUSE_MS + i * STAGGER_MS, // le premier appel de chaque ouvrier est décalé de quelques dixièmes de seconde
}));
let anyOK = false;   // vrai dès qu'une clé a obtenu une réponse
let waiters = [];
const alive = () => W.filter((w) => !w.dead);
const pool = () => { const a = alive(); return PARALLEL ? a.slice(0, MAX_WORKERS) : a.slice(0, 1); };
const poolSize = () => pool().length;

function noKeyMessage() {
  if (!W.length) return 'Aucune clé : la variable PARSE_API_KEYS (ou PARSE_API_KEY) est vide.';
  if (W.some((w) => /404/.test(w.why))) {
    return 'parse.bot répond « scraper introuvable » (404) avec ces clés. ' +
      'Ces clés viennent sans doute d\'un autre compte que celui où le scraper FUTBIN a été créé. ' +
      'Solution : écris chaque clé avec son adresse de scraper dans le secret PARSE_API_KEYS (une ligne : CLE|https://api.parse.bot/scraper/ID), ' +
      'ou mets l\'adresse commune dans la variable API_BASE.';
  }
  return 'Plus aucune clé utilisable (' + W.map((w) => `n°${w.i + 1} : ${w.why || 'ok'}`).join(' ; ') + '). ' +
    'Si tu as rechargé des crédits, relance avec « oublier les clés vides » = oui.';
}
async function acquire() {
  for (;;) {
    const p = pool();
    if (!p.length) throw new Error(noKeyMessage());
    const free = p.filter((w) => !w.busy);
    if (free.length) {
      free.sort((a, b) => a.last - b.last); // celui qui a le plus longtemps attendu
      free[0].busy = true;
      return free[0];
    }
    await new Promise((r) => waiters.push(r));
  }
}
function release(w) {
  w.busy = false;
  const r = waiters.shift();
  if (r) r();
}
function markDead(w, why, credit, detail = '') {
  if (w.dead) return;
  w.dead = true; w.why = why; w.credit = !!credit; w.deadAt = Date.now(); w.detail = detail;
  console.log(`Clé n°${w.i + 1} : ${why}${detail ? ' — réponse de parse.bot : ' + detail : ''}. ${alive().length} clé(s) encore utilisable(s) sur ${KEYS.length}.`);
  const ws = waiters; waiters = [];
  ws.forEach((r) => r()); // tout le monde se réveille et refait son choix
}

async function loadKeyState() {
  const month = new Date().toISOString().slice(0, 7);
  if (process.env.RESET_KEYS === '1') console.log('« Oublier les clés vides » demandé : toutes les clés sont réessayées.');
  let st = null;
  try { st = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { /* premier passage */ }
  // On ne reprend l'état mémorisé que si la liste de clés est la même qu'au dernier passage et que c'est le même mois.
  if (st && st.fp === FP && st.month === month) {
    if (Array.isArray(st.spent)) st.spent.forEach((v, i) => { if (W[i] && Number.isFinite(v)) W[i].spent = v; });
    if (process.env.RESET_KEYS !== '1' && Array.isArray(st.dead)) {
      const dAt = Array.isArray(st.deadAt) ? st.deadAt : [], rs = Array.isArray(st.reasons) ? st.reasons : [], retried = [];
      for (const i of st.dead) if (Number.isInteger(i) && W[i]) {
        const age = Date.now() - (Number(dAt[i]) || 0);
        if (age < DEAD_HOURS * 3600e3) {
          W[i].dead = true; W[i].keep = true; W[i].credit = true; W[i].deadAt = Number(dAt[i]); W[i].detail = rs[i] || '';
          W[i].why = `vide (mémorisée il y a ${Math.max(1, Math.round(age / 60000))} min)`;
        } else retried.push(i + 1);
      }
      if (retried.length) console.log(`Clé(s) ${retried.join(', ')} : marquée(s) vide(s) il y a plus de ${DEAD_HOURS} h (ou sans date) : on les réessaie.`);
    }
  }
  const n = alive().length;
  console.log(`Clés disponibles : ${KEYS.length}.${n < KEYS.length ? ` Dont ${KEYS.length - n} vide(s) mémorisée(s) récemment : ignorée(s).` : ''}`);
  W.forEach((w) => console.log(`  clé n°${w.i + 1} → ${ENTRIES[w.i].b ? 'scraper ' + shortUrl(w.b) : 'adresse par défaut ' + shortUrl(BASE) + ' (aucune adresse écrite après la clé)'}${w.dead ? ' [' + w.why + (w.detail ? ' — ' + w.detail : '') + ']' : ''}`));
  if (PARALLEL) console.log(`Travail en parallèle : ${poolSize()} ouvrier(s), une clé chacun, pause de ${Math.round(PAUSE_MS / 1000)} s entre deux requêtes d'une même clé.`);
  else console.log('Travail en parallèle désactivé (PARALLEL=0) : un seul ouvrier à la fois, les autres clés prennent le relais si elle est vide.');
}
async function saveKeyState() {
  if (!KEYS.length) return;
  // On mémorise une clé vide (crédits) toujours. Une clé « refusée » seulement si une autre a marché dans ce passage (sinon c'est peut-être une panne de parse.bot).
  const dead = W.filter((w) => w.dead && (w.keep || w.credit || anyOK)).map((w) => w.i);
  const month = new Date().toISOString().slice(0, 7);
  const spent = W.map((w) => w.spent);
  const left = W.map((w) => w.left);
  let prev = null;
  try { prev = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { /* pas de fichier */ }
  if (!dead.length && !prev && !spent.some((v) => v > 0)) return;
  const first = W.findIndex((w) => !w.dead);
  const budget = W.map((w) => w.budget);
  const deadAt = W.map((w) => (dead.includes(w.i) && w.deadAt ? w.deadAt : null));
  const reasons = W.map((w) => (dead.includes(w.i) ? (w.detail || null) : null));
  const out = { month, index: first < 0 ? KEYS.length : first, total: KEYS.length, fp: FP, dead, spent, left, budget, totalBudget: TOTAL_CREDITS || null, deadAt, reasons, at: new Date().toISOString() };
  const same = prev && prev.fp === FP && prev.month === month && JSON.stringify(prev.dead || []) === JSON.stringify(dead) && JSON.stringify(prev.spent || []) === JSON.stringify(spent) && JSON.stringify(prev.left || []) === JSON.stringify(left) && JSON.stringify(prev.budget || []) === JSON.stringify(budget) && (prev.totalBudget || null) === (TOTAL_CREDITS || null) && JSON.stringify(prev.deadAt || []) === JSON.stringify(deadAt);
  if (same) return;
  await writeFile(STATE_FILE, JSON.stringify(out) + '\n', 'utf8');
}

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
// Si parse.bot indique le solde dans ses en-têtes de réponse, on le lit (seuls les NOMS d'en-têtes liés aux crédits sont affichés, une seule fois).
let balanceHdrLogged = false;
function readBalance(w, headers) {
  try {
    for (const [k, v] of headers.entries()) {
      if (!/credit|balance|quota/i.test(k) || /rate/i.test(k)) continue; // « x-ratelimit-remaining » compte des requêtes, pas des crédits
      if (!balanceHdrLogged) { balanceHdrLogged = true; console.log(`Solde lu dans l'en-tête de réponse « ${k} » (exemple clé n°${w.i + 1} : ${String(v).slice(0, 40)}).`); }
      const n = Number(String(v).replace(/[^\d.]/g, ''));
      if (/remain|left|balance|available/i.test(k) && Number.isFinite(n)) w.left = n;
    }
  } catch { /* en-têtes illisibles : on ignore */ }
}

// Une requête sur UN ouvrier (une clé). Si la clé est vide ou refusée, elle est mise de côté et KeyDead est levée :
// api() redonne alors la même requête à un autre ouvrier.
async function callOn(w, endpoint, params, label) {
  const wait = w.last + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);

  const mkUrl = () => {
    const u = new URL(`${w.b}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    return u;
  };

  // Un refus isolé n'est pas une panne : on ne met la clé de côté qu'après STRIKES refus de suite.
  const strike = async (why, credit, detail) => {
    w.strikes = (w.strikes ?? 0) + 1;
    if (w.strikes >= STRIKES) { w.strikes = 0; markDead(w, why, credit, detail); throw new KeyDead(); }
    console.log(`${label} (clé n°${w.i + 1}) : refus ${w.strikes}/${STRIKES} (${why}) — ${detail}. On attend ${Math.round(RETRY_MS / 1000)} s et on réessaie avant de la mettre de côté.`);
    await sleep(RETRY_MS);
    w.last = Date.now();
  };
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const last = attempt >= MAX_TRIES;
    const t0 = Date.now();
    w.last = t0;
    let res;
    try {
      res = await fetch(mkUrl(), {
        headers: { 'X-API-Key': w.k, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (!last) {
        console.log(`${label} (clé n°${w.i + 1}) : pas de réponse (${e.name}). Nouvel essai dans ${Math.round(RETRY_MS / 1000)} s (essai ${attempt}/${MAX_TRIES}).`);
        await sleep(RETRY_MS);
        continue;
      }
      throw new Error(`${label} : impossible de joindre parse.bot (${redact(e.message)})`);
    }
    if (res.status === 404) {
      const body404 = redact((await res.clone().text().catch(() => '')).slice(0, 200));
      if (/scraper/i.test(body404) && /not found/i.test(body404)) {
        await strike('ne voit pas ce scraper (404)', false, `HTTP 404 ${body404}`);
        attempt--; continue;
      }
    }
    if ([401, 402, 403, 429].includes(res.status)) {
      const peek = await res.clone().text().catch(() => '');
      const creditLike = res.status === 402 || CREDIT_STRICT.test(peek) || (res.status !== 429 && CREDIT_LOOSE.test(peek));
      const fastBad = (res.status === 401 || res.status === 403) && (/invalid api key/i.test(peek) || (!w.ok && Date.now() - t0 < 60000));
      const snip = redact(peek.slice(0, 160).replace(/\s+/g, ' '));
      if (creditLike) { await strike('plus de crédits', true, `HTTP ${res.status} ${snip}`); attempt--; continue; }
      if (fastBad) { await strike('refusée', false, `HTTP ${res.status} ${snip}`); attempt--; continue; }
    }
    if (res.status === 401 || res.status === 403) {
      // parse.bot explique souvent la raison dans sa réponse : on l'affiche (sans jamais afficher la clé).
      const body = redact((await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' '));
      const secs = Math.round((Date.now() - t0) / 1000);
      // Un « refus » après ~1 minute, ou alors que la clé a déjà marché, est en fait un délai dépassé chez parse.bot : on réessaie.
      const timeoutLike = w.ok || secs >= 60;
      if (timeoutLike && !last) {
        console.log(`${label} (clé n°${w.i + 1}) : refus (HTTP ${res.status}) après ${secs} s, probablement un délai dépassé chez parse.bot. Réponse : ${body || '(vide)'}`);
        console.log(`Nouvel essai dans ${Math.round(RETRY_MS / 1000)} s (essai ${attempt}/${MAX_TRIES}).`);
        await sleep(RETRY_MS);
        continue;
      }
      // On écrit seulement la LONGUEUR de la clé, jamais la clé elle-même.
      throw new Error(
        `${label} : accès refusé (HTTP ${res.status}) après ${secs} s. ` +
        `Réponse de parse.bot : ${body || '(vide)'}. ` +
        `La clé n°${w.i + 1} fait ${w.k.length} caractères. ` +
        (secs < 60 && !w.ok
          ? `Refus immédiat : la clé est sans doute fausse. Teste-la avec « Send request » sur parse.bot, puis vérifie le secret PARSE_API_KEYS.`
          : `Refus lent : parse.bot n'arrive pas à répondre à temps. Réessaie plus tard, la clé semble bonne.`)
      );
    }
    if (res.status === 429 && !last) {
      console.log(`${label} (clé n°${w.i + 1}) : trop de requêtes, pause de 60 s puis nouvel essai.`);
      await sleep(60000);
      continue;
    }
    if (!res.ok) {
      const txt = redact((await res.text().catch(() => '')).slice(0, 200));
      throw new Error(`${label} : erreur HTTP ${res.status} ${txt}`);
    }
    w.ok = true; anyOK = true; w.strikes = 0;
    w.spent += COST[endpoint] ?? COST_OTHER;
    readBalance(w, res.headers);
    return res.json();
  }
  throw new Error(`${label} : échec après ${MAX_TRIES} essais`);
}

// Envoie la requête au premier ouvrier libre. Si sa clé tombe en panne, un autre reprend la même requête.
async function api(endpoint, params = {}, label = endpoint) {
  for (;;) {
    const w = await acquire();
    try { return await callOn(w, endpoint, params, label); }
    catch (e) { if (e instanceof KeyDead) continue; throw e; }
    finally { release(w); }
  }
}

// Fait tourner fn sur chaque élément, autant à la fois qu'il y a d'ouvriers.
async function forEachPar(items, fn) {
  let next = 0;
  const n = Math.max(1, Math.min(items.length, poolSize()));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const k = next++;
      if (k >= items.length) return;
      await fn(items[k], k);
    }
  }));
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

// Écritures en file d'attente : plusieurs ouvriers peuvent finir en même temps, mais le fichier n'est jamais écrit par deux à la fois.
// Si une sauvegarde est déjà en attente, elle contiendra aussi les dernières données : on n'en empile pas d'autres.
let saveChain = Promise.resolve(), savePending = false;
function saveData(d) {
  if (savePending) return saveChain;
  savePending = true;
  saveChain = saveChain.catch(() => { }).then(async () => {
    savePending = false;
    const tmp = DATA_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(d) + '\n', 'utf8');
    await rename(tmp, DATA_FILE); // écriture atomique : jamais de fichier à moitié écrit
  });
  return saveChain;
}

function addHistory(card, price, now) {
  if (price === null) return;
  card.pt = Math.floor(now / 1000); // heure du dernier relevé de prix (en secondes), même si le prix n'a pas bougé
  const h = Array.isArray(card.history) ? card.history : [];
  const last = h[h.length - 1];
  if (last && last.p === price && now - last.t < 6 * 3600 * 1000) return;
  h.push({ t: now, p: price });
  card.history = h.slice(-HISTORY_MAX);
}
// Heure (ms) du dernier relevé de prix d'une carte : 0 = jamais.
const priceTime = (c) => (c.pt ? c.pt * 1000 : (c.history && c.history.length ? c.history[c.history.length - 1].t : 0));

function mergeCard(map, fresh, now) {
  const old = map.get(fresh.id);
  if (!old) {
    addHistory(fresh, fresh.price, now);
    map.set(fresh.id, fresh);
    return;
  }
  // On garde les anciennes infos si la nouvelle réponse n'en a pas.
  for (const k of ['name', 'pos', 'club', 'nation', 'league', 'cardImage', 'playerImage', 'cardImageLarge', 'playerImageLarge', 'nationImage', 'clubImage', 'leagueImage', 'skillMoves', 'weakFoot', 'version', 'cardName', 'acc']) {
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
// Catalogue : les pages sont lues en parallèle (une par ouvrier). Le point de reprise (listNext) avance seulement
// jusqu'à la dernière page lue SANS trou : si une page échoue, la relance repart de cette page.
async function modeList(data) {
  const map = new Map(data.cards.map((c) => [c.id, c]));
  const now = Date.now();
  const restart = process.env.RESTART === '1' || SORT_DIR === 'asc'; // repart de la page 1 sans toucher au point de reprise (toujours le cas pour le passage de contrôle « asc »)
  const before = map.size;
  const start = Number.isInteger(data.listNext) && data.listNext > 0 && !restart ? data.listNext : 1;
  const pages = Array.from({ length: MAX_PAGES }, (_, i) => start + i);
  const done = new Set();
  let endPage = Infinity, total = 0, firstLog = true, stopAll = false, nextOk = start, firstErr = null;
  const failedPages = [];
  await forEachPar(pages, async (page) => {
    if (stopAll || page >= endPage) return;
    console.log(`Catalogue : page ${page} (${page - start + 1}/${MAX_PAGES} de ce passage)`);
    let payload;
    const getPage = () => api('list_fc27_players', { platform: 'ps', min_rating: MIN_RATING, sort_by_price: SORT_DIR, page }, 'list_fc27_players');
    try {
      payload = await getPage();
      if (!toArray(payload).length) { // une page vide peut être un raté de parse.bot : on la redemande une fois avant de croire que c'est la fin
        console.log(`Page ${page} vide : on la redemande une fois pour confirmer la fin du catalogue.`);
        payload = await getPage();
      }
    } catch (e) {
      failedPages.push(page);
      if (!firstErr) firstErr = e;
      console.log(`Page ${page} : ${redact(e.message)}`);
      if (!poolSize()) stopAll = true; // plus aucune clé : inutile d'essayer les autres pages
      return;
    }
    const raw = toArray(payload);
    const arr = raw.map(normPlayer).filter(Boolean);
    if (arr.length && firstLog) {
      firstLog = false;
      console.log('Champs reçus pour un joueur : ' + Object.keys(raw[0]).join(', '));
      const imgs = imageFields(raw[0]);
      console.log('Champs contenant une adresse d\'image : ' + (imgs.length ? imgs.map(([k, v]) => `${k} = ${v.slice(0, 110)}`).join(' | ') : 'aucun'));
      console.log('Photo du joueur trouvée : ' + (arr[0].playerImage ? 'oui' : 'non'));
      console.log('Logos trouvés : pays ' + (arr[0].nationImage ? 'oui' : 'non') + ' | ligue ' + (arr[0].leagueImage ? 'oui' : 'non') + ' | club ' + (arr[0].clubImage ? 'oui' : 'non'));
      console.log('Image de carte HD trouvée : ' + (arr[0].cardImageLarge ? 'oui' : 'non') + ' | photo HD : ' + (arr[0].playerImageLarge ? 'oui' : 'non'));
    }
    done.add(page);
    if (!arr.length) { endPage = Math.min(endPage, page); console.log(`Page ${page} vide (confirmée) : fin du catalogue.`); return; }
    for (const c of arr) mergeCard(map, c, Date.now());
    total += arr.length;
    data.cards = [...map.values()];
    data.updatedAt = new Date().toISOString();
    data.source = 'FUTBIN via parse.bot';
    while (done.has(nextOk)) nextOk++;
    if (!restart) data.listNext = nextOk;
    await saveData(data); // sauvegarde à chaque page : rien n'est perdu si ça s'arrête
  });
  while (done.has(nextOk)) nextOk++; // une page vide de fin peut arriver après la dernière page pleine
  const finished = endPage !== Infinity && nextOk > endPage;
  if (finished && !restart) { data.listNext = null; await saveData(data); }
  console.log(`Catalogue : ${total} cartes lues, ${data.cards.length} au total. Nouvelles cartes dans ce passage : ${map.size - before}.`);
  if (finished) console.log(`FIN DU CATALOGUE confirmée à la page ${endPage} (sens du tri : ${SORT_DIR}). Total : ${data.cards.length} cartes.` +
    ' Contrôle : le tri par prix bouge pendant la lecture, donc quelques cartes peuvent être ratées. Relance une fois avec « sens du tri » = asc : si « Nouvelles cartes » est proche de 0, le catalogue est complet.');
  if (failedPages.length) {
    if (!total) throw firstErr;
    console.log(`ATTENTION : ${failedPages.length} page(s) non lue(s) (${failedPages.sort((a, b) => a - b).slice(0, 10).join(', ')}${failedPages.length > 10 ? '…' : ''}). Rien n'est perdu : relance le mode « list » pour reprendre à la page ${nextOk}.`);
  } else if (!finished && total) console.log(`Catalogue pas fini : relance le mode « list » pour continuer à la page ${nextOk}.`);
  if (!total && !finished) throw new Error('Aucune carte reçue : vérifie la réponse de list_fc27_players.');
}

// Prix : on demande en priorité les cartes dont le prix est le plus ancien (et un peu plus souvent les plus chères),
// en plusieurs paquets de 500 envoyés en même temps. Un prix de moins de SNAPSHOT_FRESH_MIN minutes n'est pas redemandé.
async function modeSnapshot(data) {
  if (!data.cards.length) throw new Error('data.json est vide : lance d\'abord le mode « list ».');
  const t0 = Date.now();
  const weight = (c) => 1 + Math.min(2, Math.log10(Math.max(Number(c.price) || 0, 1000) / 1000) / 2);
  const eligible = data.cards
    .map((c) => { const t = priceTime(c); return { c, t, score: (t ? (t0 - t) / 60000 : 1e6) * weight(c) }; })
    .filter((x) => !x.t || t0 - x.t >= SNAPSHOT_FRESH_MIN * 60000)
    .sort((a, b) => b.score - a.score);
  const skipped = data.cards.length - eligible.length;
  if (skipped) console.log(`Prix : ${skipped} carte(s) ont un prix de moins de ${SNAPSHOT_FRESH_MIN} min : pas redemandées.`);
  const map = new Map(data.cards.map((c) => [c.id, c]));
  if (!eligible.length) console.log('Prix : rien à mettre à jour pour le moment (tous les prix sont récents).');
  else {
    const parts = Math.max(1, Math.min(SNAPSHOT_PARTS || Math.max(1, poolSize()), Math.ceil(eligible.length / SNAPSHOT_SIZE)));
    const ids = eligible.slice(0, parts * SNAPSHOT_SIZE).map((x) => x.c.id);
    const chunks = [];
    for (let i = 0; i < ids.length; i += SNAPSHOT_SIZE) chunks.push(ids.slice(i, i + SNAPSHOT_SIZE));
    console.log(`Prix : ${ids.length} cartes à relever sur ${data.cards.length}, en ${chunks.length} paquet(s) envoyé(s) en parallèle.`);
    let updated = 0, nulls = 0, okChunks = 0, firstErr = null, stopAll = false;
    await forEachPar(chunks, async (part, k) => {
      if (stopAll) return;
      console.log(`Prix : paquet ${k + 1}/${chunks.length}, ${part.length} cartes demandées.`);
      let arr;
      try {
        arr = toArray(await api('get_fc27_market_snapshot', { player_ids: part.join(',') }, 'get_fc27_market_snapshot'));
        if (!arr.length) throw new Error('Réponse vide de get_fc27_market_snapshot.');
      } catch (e) {
        if (!firstErr) firstErr = e;
        console.log(`Paquet ${k + 1} : ${redact(e.message)}`);
        if (!poolSize()) stopAll = true;
        return;
      }
      okChunks++;
      const t = Date.now();
      for (const r of arr) {
        const id = pick(r, ['player_id', 'id', 'playerId']);
        if (id === undefined) continue;
        const card = map.get(String(id));
        if (!card) continue;
        const price = toPrice(pick(r, ['price', 'ps_price', 'current_price', 'prices']));
        if (price === null) { nulls++; continue; } // on garde l'ancien prix
        card.price = price;
        addHistory(card, price, t);
        updated++;
      }
      data.updatedAt = new Date(t).toISOString();
      data.source = 'FUTBIN via parse.bot';
      await saveData(data);
    });
    console.log(`Prix : ${updated} mis à jour, ${nulls} sans prix (ancien prix gardé). Paquets réussis : ${okChunks}/${chunks.length}.`);
    if (!okChunks) throw firstErr || new Error('Aucun prix reçu.');
    if (okChunks < chunks.length) console.log('ATTENTION : certains paquets ont échoué. Les cartes concernées seront reprises en priorité au prochain passage.');
  }
  const sbcs = await fetchSbcs();
  if (sbcs) {
    data.sbcs = sbcs;
    await saveData(data);
    console.log(`SBC en cours : ${sbcs.length}.`);
  }
  await runSelection(data, await loadWatch(), 'après la mise à jour complète');
}

// ---------- attributs détaillés (Accélération, Finition, …) ----------
const SUB_KEYS = ['acceleration','sprintspeed','attposition','finishing','shotpower','longshots','volleys','penalties','vision','crossing','fkaccuracy','shortpassing','longpassing','curve','agility','balance','reactions','ballcontrol','dribbling','composure','interceptions','headingaccuracy','defawareness','standingtackle','slidingtackle','jumping','stamina','strength','aggression'];
const SUB_ALIAS = { accel: 'acceleration', sprint: 'sprintspeed', positioning: 'attposition', attackposition: 'attposition', attackpositioning: 'attposition', attpos: 'attposition', finish: 'finishing', shotpow: 'shotpower', longshot: 'longshots', penalty: 'penalties', fkacc: 'fkaccuracy', freekickaccuracy: 'fkaccuracy', freekickacc: 'fkaccuracy', shortpass: 'shortpassing', longpass: 'longpassing', ballcontrol: 'ballcontrol', dribble: 'dribbling', headingacc: 'headingaccuracy', heading: 'headingaccuracy', defensiveawareness: 'defawareness', defaware: 'defawareness', awareness: 'defawareness', standtackle: 'standingtackle', standingtack: 'standingtackle', slidetackle: 'slidingtackle', slidingtack: 'slidingtackle', jump: 'jumping', strenght: 'strength' };
function subKey(name) {
  const k = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (SUB_KEYS.includes(k)) return k;
  return SUB_ALIAS[k] || '';
}
function collectSubs(node, out = {}, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return out;
  if (Array.isArray(node)) {
    for (const it of node) {
      if (it && typeof it === 'object') {
        const nm = pick(it, ['name', 'label', 'stat', 'attribute', 'key']);
        const val = pick(it, ['value', 'val', 'rating', 'score']);
        const k = subKey(nm);
        if (k && /^\d+$/.test(String(val))) out[k] = Number(val);
        else collectSubs(it, out, depth + 1);
      }
    }
    return out;
  }
  for (const [key, v] of Object.entries(node)) {
    if (typeof v === 'number' || (typeof v === 'string' && /^\d{1,3}$/.test(v))) {
      const k = subKey(key);
      if (k) out[k] = Number(v);
    } else if (v && typeof v === 'object') collectSubs(v, out, depth + 1);
  }
  return out;
}
function applyExtras(c, root) {
  const subs = collectSubs(root);
  if (Object.keys(subs).length >= 6) c.sub = subs;
  const ev = (root && (root.evolutions || root.evos || root.evolution)) || null;
  if (Array.isArray(ev) && ev.length) {
    c.evos = ev.filter((e) => e && typeof e === 'object').slice(0, 12).map((e) => ({
      n: String(pick(e, ['name', 'title', 'evolution', 'evo_name']) ?? ''),
      e: String(pick(e, ['expires', 'expiry', 'end_date', 'expires_at', 'ends', 'expiration']) ?? ''),
      m: String(pick(e, ['min_ovr', 'max_ovr', 'requirement', 'requirements', 'eligibility', 'condition']) ?? ''),
    })).filter((e) => e.n);
  }
  const acc = pick(root || {}, ['accelerate', 'accelerate_type', 'acceleRATE', 'accelerate_name']);
  if (acc && typeof acc !== 'object') c.acc = String(acc);
  return Object.keys(subs).length;
}
// ---------- styles de jeu (PlayStyles) ----------
// Une requête par joueur : coût en crédits inconnu, donc on en demande peu (DETAILS_COUNT) et on affiche ce que ça coûte.
async function modeDetails(data) {
  if (!data.cards.length) throw new Error('data.json est vide : lance d\'abord le mode « list ».');
  const count = Math.max(1, Math.min(Number(process.env.DETAILS_COUNT) || 3, 90));
  const wanted = String(process.env.DETAILS_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const byId = new Map(data.cards.map((c) => [c.id, c]));
  let chosen;
  if (wanted.length) chosen = wanted.map((i) => byId.get(i)).filter(Boolean);
  else chosen = data.cards.filter((c) => !c.ps).sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, count);
  const ep = process.env.DETAILS_ENDPOINT || 'get_player_details';
  let done = 0, first = true;
  await forEachPar(chosen, async (c) => {
    let payload;
    try { payload = await api(ep, { player_id: c.id, year: 27 }, ep); }
    catch (e) { console.log(`${ep} : ${redact(e.message)}`); return; }
    const root = Array.isArray(payload) ? payload[0] : (payload.data || payload.player || payload);
    if (first) {
      console.log('Champs reçus (détails) : ' + Object.keys(root || {}).join(', '));
      for (const [k, v] of Object.entries(root || {})) {
        if (Array.isArray(v) && v[0] && typeof v[0] === 'object') console.log(`  ${k}[0] : ` + Object.keys(v[0]).join(', '));
      }
    }
    const raw = (root && (root.playstyles || root.play_styles || root.playStyles)) || [];
    const ps = [];
    const add = (x, grp) => {
      if (!x || typeof x !== 'object') return;
      const logo = pick(x, ['logo', 'image', 'icon', 'image_url']);
      const name = pick(x, ['name', 'title', 'label']);
      if (!logo && !name) return;
      const l = logo ? String(logo) : '';
      const gold = grp === 'plus' || (!grp && (x.plus === true || x.is_plus === true || x.type === 'plus' || /\/plus\//i.test(l)));
      const item = { n: name ? String(name) : '', l, g: gold };
      const k = pick(x, ['category', 'type_category', 'group']);
      if (k) item.k = String(k).toLowerCase();
      if (grp === 'locked') item.x = true;
      ps.push(item);
    };
    if (Array.isArray(raw)) raw.forEach((x) => add(x, ''));
    else if (raw && typeof raw === 'object') for (const grp of ['plus', 'basic', 'locked']) (Array.isArray(raw[grp]) ? raw[grp] : []).forEach((x) => add(x, grp));
    c.ps = ps;
    const nSub = applyExtras(c, root);
    if (first) { first = false; console.log(`Attributs détaillés trouvés : ${nSub} sur 29${nSub < 6 ? ' (pas assez : la source ne les donne pas dans cette réponse)' : ''}`); }
    done++;
    console.log(`${c.name} : ${ps.length} style(s) de jeu (${ps.filter((p) => p.g && !p.x).length} doré(s), ${ps.filter((p) => p.x).length} verrouillé(s)).`);
    await saveData(data);
  });
  if (!done) throw new Error('Aucun détail reçu : le nom du point d\'accès est peut-être différent (voir les messages ci-dessus).');
  console.log(`Détails enregistrés pour ${done} joueur(s). Regarde ton solde de crédits sur parse.bot pour connaître le prix d'une requête.`);
}

// ---------- fiche complète (nom de carte + logos) ----------
// get_fc27_player_price : une requête par joueur, coût inconnu → petit nombre par défaut.
async function modeFiche(data) {
  if (!data.cards.length) throw new Error('data.json est vide : lance d\'abord le mode « list ».');
  const count = Math.max(1, Math.min(Number(process.env.DETAILS_COUNT) || 3, 90));
  const chosen = data.cards.filter((c) => !c.cardName).sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, count);
  let done = 0, first = true;
  await forEachPar(chosen, async (c) => {
    let payload;
    try { payload = await api('get_fc27_player_price', { player_id: c.id }, 'get_fc27_player_price'); }
    catch (e) { console.log(`${c.name} : ${redact(e.message)}`); return; }
    const root = Array.isArray(payload) ? payload[0] : (payload && (payload.data || payload.player) || payload);
    if (!root || typeof root !== 'object') return;
    if (first) console.log('Champs reçus (fiche) : ' + Object.keys(root).join(', '));
    const n = pick(root, ['name', 'card_name']);
    if (n) c.cardName = String(n);
    const f = normPlayer({ ...root, id: c.id, player_id: c.id });
    for (const k of ['nationImage', 'clubImage', 'leagueImage']) if (f && f[k]) c[k] = f[k];
    const nSub = applyExtras(c, root);
    if (first) { first = false; console.log(`Attributs détaillés trouvés : ${nSub} sur 29`); }
    done++;
    console.log(`${c.name} → carte « ${c.cardName || '?'} » | pays ${c.nationImage ? 'oui' : 'non'} | ligue ${c.leagueImage ? 'oui' : 'non'} | club ${c.clubImage ? 'oui' : 'non'}`);
    await saveData(data);
  });
  if (!done) throw new Error('Aucune fiche reçue (voir les messages ci-dessus).');
  console.log(`Fiches enregistrées : ${done}. Regarde ton solde de crédits sur parse.bot pour connaître le prix d'une requête.`);
}

// ---------- sélection des cartes à surveiller (calcul local : 0 crédit) ----------
const WATCH_FILE = path.join(DIR, 'watch.json');
const WATCH_COUNT = Number(process.env.WATCH_COUNT) || 20;               // combien de cartes surveillées
const SELECT_MINUTES = Number(process.env.SELECT_MINUTES ?? 60);         // nouvelle sélection toutes les 60 min
const WATCH_MINUTES = Number(process.env.WATCH_MINUTES ?? 60);           // pas de nouvelle requête avant 60 min
const WATCH_COST = Number(process.env.WATCH_COST ?? 10);                 // crédits estimés par requête
const MONTH_BUDGET = Number(process.env.MONTH_BUDGET ?? 8000);           // crédits max/mois pour la surveillance
const TAX = 0.05;

async function loadWatch() {
  try {
    const w = JSON.parse(await readFile(WATCH_FILE, 'utf8'));
    if (!Array.isArray(w.items)) w.items = [];
    return w;
  } catch {
    return { selectedAt: null, checkedAt: null, month: '', spent: 0, items: [] };
  }
}
async function saveWatch(w) {
  const tmp = WATCH_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(w) + '\n', 'utf8');
  await rename(tmp, WATCH_FILE);
}
const med = (a) => { const b = [...a].sort((x, y) => x - y), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };

// Même idée que l'onglet « Revente rapide » du site : carte nettement sous son prix habituel, gain net (taxe 5 %) suffisant.
function selectRapide(data, count) {
  const out = [];
  for (const c of data.cards) {
    const price = Number(c.price);
    const h = (Array.isArray(c.history) ? c.history : []).map((x) => Number(x && x.p)).filter((v) => v > 0);
    if (!(price >= 500) || h.length < 4) continue;
    const m = med(h);
    const disc = (m - price) / m;
    if (disc < 0.04) continue;
    const sell = Math.round(m * 0.98);
    const net = sell * (1 - TAX) - price, pct = net / price;
    if (net <= 0 || pct < 0.03) continue;
    const mn = Math.min(...h), mx = Math.max(...h);
    const range = mx > mn ? (price - mn) / (mx - mn) : 0.5;
    const avg = h.reduce((a, b) => a + b, 0) / h.length;
    const cv = Math.sqrt(h.reduce((a, b) => a + (b - avg) ** 2, 0) / h.length) / avg;
    const prev = h[h.length - 2], last = h[h.length - 1];
    const chg = prev > 0 ? (last - prev) / prev : 0;
    let sc = 40 * Math.min(1, disc / 0.15) + 25 * (1 - Math.min(1, Math.max(0, range)));
    sc += chg <= -0.06 ? 3 : chg < 0 ? 12 : 20;
    sc += 15 * (1 - Math.min(1, cv / 0.2));
    const w = h.length >= 10 ? 1 : h.length >= 4 ? 0.9 : 0.7;
    out.push({ id: c.id, score: Math.round(Math.min(100, sc) * w), buy: price, sell, why: `${(disc * 100).toFixed(0)} % sous son prix habituel` });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, count);
}

async function runSelection(data, w, why) {
  const items = selectRapide(data, WATCH_COUNT);
  w.items = items;
  w.selectedAt = new Date().toISOString();
  await saveWatch(w);
  console.log(`Sélection (${why}) : ${items.length} cartes à surveiller (0 crédit).`);
}
async function modeSelect(data) {
  await runSelection(data, await loadWatch(), 'manuelle');
}

async function modeWatch(data) {
  const w = await loadWatch();
  const now = Date.now();
  const age = (iso) => (iso ? (now - Date.parse(iso)) / 60000 : Infinity);
  if (age(w.selectedAt) >= SELECT_MINUTES || !w.items.length) await runSelection(data, w, 'toutes les heures');
  if (!w.items.length) { console.log('Rien à surveiller pour le moment : aucune requête envoyée, 0 crédit dépensé.'); return; }
  if (age(w.checkedAt) < WATCH_MINUTES) { console.log(`Dernier contrôle il y a ${Math.round(age(w.checkedAt))} min (< ${WATCH_MINUTES}) : rien envoyé, 0 crédit.`); return; }
  const month = new Date(now).toISOString().slice(0, 7);
  if (w.month !== month) { w.month = month; w.spent = 0; }
  if (w.spent + WATCH_COST > MONTH_BUDGET) { console.log(`Budget du mois atteint (${w.spent}/${MONTH_BUDGET} crédits estimés) : surveillance en pause jusqu'au mois prochain.`); await saveWatch(w); return; }
  const ids = w.items.map((i) => i.id);
  console.log(`Surveillance : ${ids.length} cartes demandées (seulement celles choisies par l'IA).`);
  const payload = await api('get_fc27_market_snapshot', { player_ids: ids.join(',') }, 'get_fc27_market_snapshot');
  w.spent += WATCH_COST; // compté dès que la requête part
  const arr = toArray(payload);
  const map = new Map(data.cards.map((c) => [c.id, c]));
  const want = new Set(ids);
  let updated = 0;
  for (const r of arr) {
    const id = pick(r, ['player_id', 'id', 'playerId']);
    if (id === undefined || !want.has(String(id))) continue;
    const card = map.get(String(id));
    const price = toPrice(pick(r, ['price', 'ps_price', 'current_price', 'prices']));
    if (!card || price === null) continue;
    card.price = price;
    addHistory(card, price, now);
    updated++;
  }
  console.log(`Surveillance : ${updated} prix mis à jour. Crédits estimés ce mois-ci : ${w.spent}/${MONTH_BUDGET}.`);
  if (!arr.length) { await saveWatch(w); throw new Error('Réponse vide de get_fc27_market_snapshot.'); }
  data.updatedAt = new Date(now).toISOString();
  await saveData(data);
  w.checkedAt = new Date(now).toISOString();
  await saveWatch(w);
  // Les prix ont bougé : l'IA refait son choix tout de suite (gratuit).
  await runSelection(data, w, 'après mise à jour des prix');
}

// ---------- départ ----------
async function main() {
  await loadKeyState();
  if (!W.length) {
    console.error('Aucune clé : la variable PARSE_API_KEYS (ou PARSE_API_KEY) est vide. Crée le secret PARSE_API_KEYS dans Settings → Secrets and variables → Actions.');
    process.exit(1);
  }
  if (!alive().length) {
    console.log('Toutes les clés ont été marquées vides il y a moins de ' + DEAD_HOURS + ' h : rien n\'est envoyé. Elles seront réessayées toutes seules ensuite. Si tu as rechargé des crédits, relance avec « oublier les clés vides » = oui.');
    return;
  }
  let mode = (process.argv[2] || process.env.MODE || 'auto').trim().toLowerCase();
  if (!['auto', 'list', 'snapshot', 'details', 'fiche', 'select', 'watch'].includes(mode)) mode = 'auto';
  const data = await loadData();
  if (mode === 'auto') mode = data.cards.length ? 'snapshot' : 'list';
  console.log(`Mode : ${mode}`);
  const t0 = Date.now();
  if (mode === 'list') await modeList(data);
  else if (mode === 'fiche') await modeFiche(data);
  else if (mode === 'details') await modeDetails(data);
  else if (mode === 'select') await modeSelect(data);
  else if (mode === 'watch') await modeWatch(data);
  else await modeSnapshot(data);
  console.log(`Terminé en ${Math.round((Date.now() - t0) / 1000)} s.`);
  await saveKeyState();
}

main().catch(async (e) => {
  console.error('ERREUR :', redact(e.message));
  try { await saveKeyState(); } catch { /* rien */ }
  process.exit(1);
});
