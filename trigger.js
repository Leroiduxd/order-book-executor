// trigger.js — version sans .env, tout en dur
import { ethers } from 'ethers';
import { spawn } from 'node:child_process';

/* =========================
   CONFIG (tout en dur)
========================= */
// Réseau & Oracle (Atlantic)
const RPC_URL       = 'https://atlantic.dplabs-internal.com';
const FEED_ADDR     = '0x26524d23f70fbb17c8d5d5c3353a9693565b9be0'.toLowerCase();

// Contrat d’exécution (même que ton executor.js)
const EXECUTOR_ADDR = '0x01b9cb7ac346a3c97bb6fcf654480baa2060a61f';

// Clé privée (ASSET 0)
const PRIVATE_KEY   = '0xe12f9b03327a875c2d5bf9b40a75cd2effeed46ea508ee595c6bc708c386da8c';

// API
const API_BASE      = 'https://api.brokex.trade';

// Logique
const PAIR_INDEX    = 0;       // getSvalues([PAIR_INDEX])
const ASSET_ID      = 0;       // pour /bucket/range et executor
const RANGE_RATE    = 0.0002;  // ±0.02%
const MAX_IDS       = 200;     // batch size vers executor.js
const CALL_DELAY_MS = 1000;    // 1 seconde entre batches

// Planning : secondes de la minute pour déclencher
const RUN_SECONDS   = [3, 15, 27, 39, 51];

/* =========================
   ETHERS (v6)
========================= */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const FEED_ABI = [
  'function getSvalues(uint256[] _pairIndexes) view returns (tuple(uint256 round,uint256 decimals,uint256 time,uint256 price)[] out)'
];
const feed = new ethers.Contract(FEED_ADDR, FEED_ABI, provider);

/* =========================
   UTILS
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
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function uniqSortedIds(arr) {
  return Array.from(new Set(arr.map(Number)))
    .filter(n => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
}

/* =========================
   EXECUTOR WRAPPER
========================= */
async function runExecutor(mode, { assetId, ids, pk }) {
  if (!ids?.length) return;

  const batches = chunk(ids, MAX_IDS);
  for (const group of batches) {
    const argIds = JSON.stringify(group);
    const args = [
      'executor.js',
      mode,                 // limit | sl | tp | liq
      argIds,               // "[...ids]"
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

    await sleep(CALL_DELAY_MS);
  }
}

/* =========================
   CORE
========================= */
let isRunning = false;

async function runOnce() {
  if (isRunning) return;  // anti-overlap
  isRunning = true;
  try {
    // 1) Oracle: getSvalues([PAIR_INDEX])
    const out = await feed.getSvalues([BigInt(PAIR_INDEX)]);
    if (!out || !out[0]) {
      log('[trigger] ⚠️ getSvalues vide.');
      return;
    }
    const { price, decimals } = out[0];
    const priceHuman = Number(price) / (10 ** Number(decimals));
    log(`[trigger] 🔔 getSvalues pair=${PAIR_INDEX} → price=${priceHuman} (decimals=${decimals})`);

    // 2) API : /bucket/range (±0.02 %)
    const from = priceHuman * (1 - RANGE_RATE);
    const to   = priceHuman * (1 + RANGE_RATE);
    const url  = `${API_BASE}/bucket/range?asset=${ASSET_ID}&from=${from}&to=${to}&types=orders,stops&side=all&sort=lots&order=desc`;
    const data = await fetchJson(url);

    const ORDERS = Array.isArray(data.items_orders) ? data.items_orders : [];
    const STOPS  = Array.isArray(data.items_stops)  ? data.items_stops  : [];

    const orderIds = uniqSortedIds(ORDERS.map(o => o.id));
    const stopsSL  = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase() === 'SL').map(s => s.id));
    const stopsTP  = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase() === 'TP').map(s => s.id));
    const stopsLIQ = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase() === 'LIQ').map(s => s.id));

    log(`[trigger] ✅ Collecté asset=${ASSET_ID} → ORDERS=${orderIds.length}, SL=${stopsSL.length}, TP=${stopsTP.length}, LIQ=${stopsLIQ.length}`);

    // 3) Exécutions séparées via executor.js (lots de 200, 1s pause)
    if (orderIds.length) await runExecutor('limit', { assetId: ASSET_ID, ids: orderIds, pk: PRIVATE_KEY });
    if (stopsSL.length)  await runExecutor('sl',    { assetId: ASSET_ID, ids: stopsSL,  pk: PRIVATE_KEY });
    if (stopsTP.length)  await runExecutor('tp',    { assetId: ASSET_ID, ids: stopsTP,  pk: PRIVATE_KEY });
    if (stopsLIQ.length) await runExecutor('liq',   { assetId: ASSET_ID, ids: stopsLIQ, pk: PRIVATE_KEY });

    log('[trigger] ✅ Cycle complet exécuté');
  } catch (e) {
    log('[trigger] 💥 Error:', e?.shortMessage || e?.message || String(e));
  } finally {
    isRunning = false;
  }
}

/* =========================
   SCHEDULER (3,15,27,39,51 s)
========================= */
function startScheduler() {
  log(`[trigger] 🕒 Scheduler prêt (secondes=${RUN_SECONDS.join(',')}) | RPC=${RPC_URL} | FEED=${FEED_ADDR}`);
  let lastSecond = -1;

  setInterval(() => {
    const now = new Date();
    const sec = now.getSeconds();
    if (sec === lastSecond) return;
    lastSecond = sec;

    if (RUN_SECONDS.includes(sec)) runOnce();
  }, 250);
}

startScheduler();


