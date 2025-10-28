// trigger.js
import 'dotenv/config';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';

/* ========================================
   CONFIGURATION DE BASE
======================================== */
const WSS_URL   = process.env.WSS_URL || 'wss://testnet.dplabs-internal.com';
const FEED_ADDR = (process.env.FEED_CONTRACT_ADDR || '').toLowerCase();
const TOPIC0    = (process.env.TOPIC_FEEDUPDATED || '').toLowerCase();

const API_BASE  = process.env.API_BASE || 'https://api.brokex.trade';
const EXECUTOR_ADDR = process.env.EXECUTOR_ADDR || process.env.EXECUTOR_CONTRACT_ADDR;
const RPC_URL   = process.env.RPC_URL || process.env.RPC_HTTP || 'https://testnet.dplabs-internal.com';

const RANGE_RATE = Number(process.env.RANGE_RATE || 0.0002); // ±0.02 %
const MAX_IDS    = Number(process.env.MAX_IDS_PER_CALL || 200);
const CALL_DELAY = Number(process.env.CALL_DELAY_MS || 1000);
const EVENT_DEBOUNCE_MS = Number(process.env.EVENT_DEBOUNCE_MS || 8000);

let KEYS_BY_ASSET = {};
try { KEYS_BY_ASSET = JSON.parse(process.env.KEYS_BY_ASSET || '{}'); } catch {}

/* ========================================
   UTILITAIRES
======================================== */
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
function uniqSorted(arr) {
  return Array.from(new Set(arr.map(Number))).sort((a,b)=>a-b);
}

/* ========================================
   EXÉCUTEUR LOCAL (spawner)
======================================== */
async function runExecutor(mode, { assetId, ids, pk }) {
  if (!ids?.length) return;
  if (!EXECUTOR_ADDR) throw new Error('EXECUTOR_ADDR manquant dans .env');

  const batches = chunk(ids, MAX_IDS);
  for (const group of batches) {
    const argIds = JSON.stringify(group);
    const args = [
      'executor.js',
      mode,               // limit | sl | tp | liq
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

/* ========================================
   TRAITEMENT D’UN EVENT
======================================== */
async function handleFeedUpdated({ assetId, price }) {
  const from = price * (1 - RANGE_RATE);
  const to   = price * (1 + RANGE_RATE);
  const url = `${API_BASE}/bucket/range?asset=${assetId}&from=${from}&to=${to}&types=orders,stops&side=all&sort=lots&order=desc`;

  const data = await fetchJson(url);
  const ORDERS = Array.isArray(data.items_orders) ? data.items_orders : [];
  const STOPS  = Array.isArray(data.items_stops)  ? data.items_stops  : [];

  const orderIds = uniqSorted(ORDERS.map(o => o.id));
  const stopsSL  = uniqSorted(STOPS.filter(s => s.type?.toUpperCase() === 'SL').map(s => s.id));
  const stopsTP  = uniqSorted(STOPS.filter(s => s.type?.toUpperCase() === 'TP').map(s => s.id));
  const stopsLIQ = uniqSorted(STOPS.filter(s => s.type?.toUpperCase() === 'LIQ').map(s => s.id));

  log(`[trigger] ✅ Collecté asset=${assetId} → ORDERS=${orderIds.length}, SL=${stopsSL.length}, TP=${stopsTP.length}, LIQ=${stopsLIQ.length}`);

  const pk = KEYS_BY_ASSET[String(assetId)] || process.env.PRIVATE_KEY;
  if (!pk) return log(`[trigger] ⚠️ Aucune clé pour asset ${assetId}, exécution ignorée.`);

  if (orderIds.length) await runExecutor('limit', { assetId, ids: orderIds, pk });
  if (stopsSL.length)  await runExecutor('sl',    { assetId, ids: stopsSL,  pk });
  if (stopsTP.length)  await runExecutor('tp',    { assetId, ids: stopsTP,  pk });
  if (stopsLIQ.length) await runExecutor('liq',   { assetId, ids: stopsLIQ, pk });

  log('[trigger] ✅ Cycle complet exécuté');
}

/* ========================================
   ÉCOUTE DES EVENTS
======================================== */
const recentByAsset = new Map();

function start() {
  const ws = new WebSocket(WSS_URL);

  ws.on('open', () => {
    log(`[trigger] ✅ Connecté à ${WSS_URL}`);
    const sub = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_subscribe',
      params: ['logs', { address: FEED_ADDR, topics: [TOPIC0] }]
    };
    ws.send(JSON.stringify(sub));
    log(`[trigger] 📡 Abonné à FeedUpdated sur ${FEED_ADDR}`);
  });

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.method !== 'eth_subscription' || !data.params?.result) return;

      const logEvent = data.params.result;
      if ((logEvent.topics[0] || '').toLowerCase() !== TOPIC0) return;

      const assetId = parseInt(logEvent.topics[1], 16);
      const clean = (logEvent.data || '').replace(/^0x/, '');
      const parts = clean.match(/.{1,64}/g) || [];
      if (parts.length < 4) return;

      const price = Number(BigInt('0x' + parts[0])) / 1e18;
      const now = Date.now();
      const prev = recentByAsset.get(assetId) || { t: 0, lastPrice: NaN };

      if (now - prev.t < EVENT_DEBOUNCE_MS &&
          Math.abs((price - prev.lastPrice) / (prev.lastPrice || 1)) < 1e-6) return;

      recentByAsset.set(assetId, { t: now, lastPrice: price });
      log(`[trigger] 🔔 FeedUpdated asset=${assetId} price=${price}`);
      await handleFeedUpdated({ assetId, price });
    } catch (err) {
      log('[trigger] 💥 Parse error:', err.message);
    }
  });

  ws.on('close', () => log('[trigger] ❌ WebSocket fermé'));
  ws.on('error', (err) => log('[trigger] ⚠️ Erreur WS:', err.message));
}

start();
