// trigger.js
import { ethers } from "ethers";
import { spawn } from "node:child_process";

/* ========================================
   CONFIGURATION
======================================== */
const RPC_URL = "https://atlantic.dplabs-internal.com";
const CONTRACT_ADDR = "0x26524d23f70fbb17c8d5d5c3353a9693565b9be0";
const ABI = [{
  "inputs": [{ "internalType": "uint256[]", "name": "_pairIndexes", "type": "uint256[]" }],
  "name": "getSvalues",
  "outputs": [{
    "components": [
      { "internalType": "uint256", "name": "round", "type": "uint256" },
      { "internalType": "uint256", "name": "decimals", "type": "uint256" },
      { "internalType": "uint256", "name": "time", "type": "uint256" },
      { "internalType": "uint256", "name": "price", "type": "uint256" }
    ],
    "internalType": "struct ISupraSValueFeed.priceFeed[]",
    "name": "out",
    "type": "tuple[]"
  }],
  "stateMutability": "view",
  "type": "function"
}];

const API_BASE = "https://api.brokex.trade";
const EXECUTOR_ADDR = "0x01b9cb7ac346a3c97bb6fcf654480baa2060a61f";

const RANGE_RATE = 0.0002;
const MAX_IDS = 200;
const CALL_DELAY = 1000;

/* ========================================
   UTILS
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
   EXECUTOR CALLER
======================================== */
async function runExecutor(mode, { assetId, ids }) {
  if (!ids?.length) return;

  const batches = chunk(ids, MAX_IDS);
  for (const group of batches) {
    const argIds = JSON.stringify(group);
    const args = [
      'executor.js',
      mode,
      argIds,
      `--asset=${assetId}`,
      `--addr=${EXECUTOR_ADDR}`,
      `--rpc=${RPC_URL}`
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
   TRAITEMENT DU PRIX
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

  if (orderIds.length) await runExecutor('limit', { assetId, ids: orderIds });
  if (stopsSL.length)  await runExecutor('sl',    { assetId, ids: stopsSL });
  if (stopsTP.length)  await runExecutor('tp',    { assetId, ids: stopsTP });
  if (stopsLIQ.length) await runExecutor('liq',   { assetId, ids: stopsLIQ });

  log('[trigger] ✅ Cycle complet exécuté');
}

/* ========================================
   LOOP getSvalues
======================================== */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDR, ABI, provider);

async function poll() {
  try {
    const res = await contract.getSvalues([0]);
    const feed = res[0];
    const price = Number(feed.price) / 10 ** Number(feed.decimals);
    const assetId = 0;

    log(`[trigger] 🔔 getSvalues() → price=${price}`);
    await handleFeedUpdated({ assetId, price });
  } catch (err) {
    log(`[trigger] 💥 Erreur getSvalues():`, err.message);
  }
}

async function start() {
  log(`[trigger] 🚀 Scheduler Supra getSvalues activé`);
  while (true) {
    const s = new Date().getSeconds();
    if ([3, 15, 27, 39, 51].includes(s)) await poll();
    await sleep(1000);
  }
}

start();
