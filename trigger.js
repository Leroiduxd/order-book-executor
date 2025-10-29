// trigger.js
import 'dotenv/config';
import { ethers } from 'ethers';
import { spawn } from 'node:child_process';

/* =========================
   ENV & CONSTANTES
========================= */
const RPC_URL      = process.env.RPC_URL  || 'https://atlantic.dplabs-internal.com';
const FEED_ADDR    = (process.env.FEED_CONTRACT_ADDR || '0x26524d23f70fbb17c8d5d5c3353a9693565b9be0').toLowerCase();
const API_BASE     = process.env.API_BASE || 'https://api.brokex.trade';
const EXECUTOR_ADDR= process.env.EXECUTOR_ADDR || process.env.EXECUTOR_CONTRACT_ADDR; // alias

// planification : secondes de la minute où on déclenche
const RUN_SECONDS  = (process.env.RUN_SECONDS || '3,15,27,39,51')
  .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n>=0 && n<60);

// logique d’exécution
const RANGE_RATE   = Number(process.env.RANGE_RATE || 0.0002); // ±0.02%
const MAX_IDS      = Number(process.env.MAX_IDS_PER_CALL || 200);
const CALL_DELAY   = Number(process.env.CALL_DELAY_MS || 1000);

// mapping clés privées par asset (JSON)
let KEYS_BY_ASSET = {};
try { KEYS_BY_ASSET = JSON.parse(process.env.KEYS_BY_ASSET || '{}'); } catch { KEYS_BY_ASSET = {}; }

// par défaut on cible pairIndex 0 => assetId 0
const PAIR_INDEX   = Number(process.env.PAIR_INDEX || 0);
const ASSET_ID     = Number(process.env.ASSET_ID   || 0);

// Ethers v6 provider + contract
const provider = new ethers.JsonRpcProvider(RPC_URL);
const ABI = [
  'function getSvalues(uint256[] _pairIndexes) view returns (tuple(uint256 round,uint256 decimals,uint256 time,uint256 price)[] out)'
];
const feed = new ethers.Contract(FEED_ADDR, ABI, provider);

/* =========================
   HELPERS
========================= */
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}
function chunk(arr, n) {
  const out = [];
  for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i, i+n));
  return out;
}
function uniqSortedIds(arr) {
  return Array.from(new Set(arr.map(Number))).filter(n => Number.isFinite(n) && n>=0).sort((a,b)=>a-b);
}

/* =========================
   EXECUTOR WRAPPER
========================= */
async function runExecutor(mode, { assetId, ids, pk }) {
  if (!ids?.length) return;
  if (!EXECUTOR_ADDR) throw new Error('EXECUTOR_ADDR manquant dans .env');

  const batches = chunk(ids, MAX_IDS);
  for (const group of batches) {
    const argIds = JSON.stringify(group);
    const args = [
      'executor.js',
      mode,                // limit | sl | tp | liq
      argIds,
      `--asset=${assetId}`,
      `--addr=${EXECUTOR_ADDR}`,
      `--rpc=${RPC_URL}`,
      `--pk=${pk}`
    ];

    await new Promise((resolve, reject) => {
      const p = spawn('node', args, { stdio: 'inherit' });
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${mode} exit ${code}`)));
      p.on('error', reject);
    });

    await sleep(CALL_DELAY);
  }
}

/* =========================
   CORE : une exécution planifiée
========================= */
let isRunning = false;

async function runOnce() {
  if (isRunning) return; // anti-overlap
  isRunning = true;
  try {
    // 1) Oracle: getSvalues([PAIR_INDEX])
    const out = await feed.getSvalues([BigInt(PAIR_INDEX)]);
    if (!out || !out[0]) {
      log('[trigger] ⚠️ getSvalues a renvoyé un résultat vide.');
      return;
    }
    const { price, decimals } = out[0];
    const priceHuman = Number(price) / (10 ** Number(decimals));

    log(`[trigger] 🔔 Fetched price from getSvalues pair=${PAIR_INDEX} → price=${priceHuman} (decimals=${decimals})`);

    // 2) API : /bucket/range dans ±0.02 %
    const from = priceHuman * (1 - RANGE_RATE);
    const to   = priceHuman * (1 + RANGE_RATE);
    const url  = `${API_BASE}/bucket/range?asset=${ASSET_ID}&from=${from}&to=${to}&types=orders,stops&side=all&sort=lots&order=desc`;
    const data = await fetchJson(url);

    const ORDERS = Array.isArray(data.items_orders) ? data.items_orders : [];
    const STOPS  = Array.isArray(data.items_stops)  ? data.items_stops  : [];

    const orderIds = uniqSortedIds(ORDERS.map(o => o.id));
    const stopsSL  = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase()==='SL').map(s => s.id));
    const stopsTP  = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase()==='TP').map(s => s.id));
    const stopsLIQ = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase()==='LIQ').map(s => s.id));

    log(`[trigger] ✅ Collecté asset=${ASSET_ID} → ORDERS=${orderIds.length}, SL=${stopsSL.length}, TP=${stopsTP.length}, LIQ=${stopsLIQ.length}`);

    // 3) Choix de la clé pour l’asset
    const pk = KEYS_BY_ASSET[String(ASSET_ID)] || process.env.PRIVATE_KEY;
    if (!pk) {
      log(`[trigger] ⚠️ aucune clé pour asset ${ASSET_ID} (KEYS_BY_ASSET / PRIVATE_KEY) — skip envoi`);
      return;
    }

    // 4) Exécutions via executor.js (séparées)
    if (orderIds.length) await runExecutor('limit', { assetId: ASSET_ID, ids: orderIds, pk });
    if (stopsSL.length)  await runExecutor('sl',    { assetId: ASSET_ID, ids: stopsSL,  pk });
    if (stopsTP.length)  await runExecutor('tp',    { assetId: ASSET_ID, ids: stopsTP,  pk });
    if (stopsLIQ.length) await runExecutor('liq',   { assetId: ASSET_ID, ids: stopsLIQ, pk });

    log('[trigger] ✅ Cycle complet exécuté');
  } catch (e) {
    log('[trigger] 💥 Error:', e?.shortMessage || e?.message || String(e));
  } finally {
    isRunning = false;
  }
}

/* =========================
   SCHEDULER : 3,15,27,39,51 s
========================= */
function startScheduler() {
  log(`[trigger] 🕒 Scheduler prêt (secondes=${RUN_SECONDS.join(',')}) | RPC=${RPC_URL} | FEED=${FEED_ADDR}`);
  let lastSecond = -1;

  setInterval(async () => {
    const now = new Date();
    const sec = now.getSeconds();
    if (sec === lastSecond) return; // éviter le double-fire si tick imprécis
    lastSecond = sec;

    if (RUN_SECONDS.includes(sec)) {
      runOnce(); // non bloquant grâce au flag isRunning
    }
  }, 250); // tick fin (250ms) pour être réactif sans spam
}

startScheduler();

