// trigger.js — multi-assets, per-asset PK, parallel execution
import { ethers } from 'ethers';
import { spawn } from 'node:child_process';

/* =========================
   ASSETS (ta liste)
========================= */
const ASSETS = [
  { key:'btc_usdt', id:0,   name:'BITCOIN',   marketId:1, override:{num:1,   den:100}, priceUSD:65000 },
  { key:'eth_usdt', id:1,   name:'ETHEREUM',  marketId:1, override:{num:1,   den:100}, priceUSD:2500  },
  { key:'sol_usdt', id:10,  name:'SOLANA',    marketId:1, override:{num:1,   den:10 }, priceUSD:180   },
  { key:'xrp_usdt', id:14,  name:'RIPPLE',    marketId:1, override:{num:10,  den:1  }, priceUSD:0.55  },
  { key:'avax_usdt',id:5,   name:'AVALANCHE', marketId:1, override:{num:1,   den:10 }, priceUSD:30    },
  { key:'doge_usdt',id:3,   name:'DOGECOIN',  marketId:1, override:{num:100, den:1  }, priceUSD:0.30  },
  { key:'trx_usdt', id:15,  name:'TRON',      marketId:1, override:{num:100, den:1  }, priceUSD:0.11  },
  { key:'ada_usdt', id:16,  name:'CARDANO',   marketId:1, override:{num:100, den:1  }, priceUSD:0.45  },
  { key:'sui_usdt', id:90,  name:'SUI',       marketId:1, override:{num:10,  den:1  }, priceUSD:1.2   },
  { key:'link_usdt',id:2,   name:'CHAINLINK', marketId:1, override:{num:10,  den:1  }, priceUSD:13    },

  // FOREX (micro-lots)
  { key:'aud_usd', id:5010, name:'AUSTRALIAN DOLLAR',   marketId:2, override:{num:1000, den:1}, priceUSD:0.66 },
  { key:'eur_usd', id:5000, name:'EURO',                marketId:2, override:{num:1000, den:1}, priceUSD:1.08 },
  { key:'gbp_usd', id:5002, name:'GREAT BRITAIN POUND', marketId:2, override:{num:1000, den:1}, priceUSD:1.26 },
  { key:'nzd_usd', id:5013, name:'NEW ZEALAND DOLLAR',  marketId:2, override:{num:1000, den:1}, priceUSD:0.61 },
  { key:'usd_cad', id:5011, name:'CANADIAN DOLLAR',     marketId:2, override:{num:1000, den:1}, priceUSD:1.36 },
  { key:'usd_chf', id:5012, name:'SWISS FRANC',         marketId:2, override:{num:1000, den:1}, priceUSD:0.90 },
  { key:'usd_jpy', id:5001, name:'JAPANESE YEN',        marketId:2, override:{num:1000, den:1}, priceUSD:155  },

  // COMMODITIES
  { key:'xag_usd', id:5501, name:'SILVER',               marketId:2, override:{num:1, den:1},   priceUSD:28   },
  { key:'xau_usd', id:5500, name:'GOLD',                 marketId:2, override:{num:1, den:100}, priceUSD:2400 },
  { key:'wti_usd', id:5503, name:'WEST TEXAS INTERMEDIATE CRUDE', marketId:2, override:{num:1, den:1}, priceUSD:80 },

  // INDICES / ETF
  { key:'spdia_usd', id:6113, name:'SPDR S&P 500 ETF',         marketId:2, override:{num:1, den:1}, priceUSD:520 },
  { key:'qqqm_usd',  id:6114, name:'NASDAQ-100 ETF',           marketId:2, override:{num:1, den:1}, priceUSD:200 },
  { key:'iwm_usd',   id:6115, name:'ISHARES RUSSELL 2000 ETF', marketId:2, override:{num:1, den:1}, priceUSD:210 },

  // STOCKS
  { key:'aapl_usd', id:6004, name:'APPLE INC.',          marketId:3, override:{num:1, den:1}, priceUSD:230 },
  { key:'amzn_usd', id:6005, name:'AMAZON',              marketId:3, override:{num:1, den:1}, priceUSD:180 },
  { key:'coin_usd', id:6010, name:'COINBASE',            marketId:3, override:{num:1, den:1}, priceUSD:220 },
  { key:'goog_usd', id:6003, name:'ALPHABET INC.',       marketId:3, override:{num:1, den:1}, priceUSD:165 },
  { key:'gme_usd',  id:6011, name:'GAMESTOP CORP.',      marketId:3, override:{num:1, den:1}, priceUSD:25  },
  { key:'intc_usd', id:6009, name:'INTEL CORPORATION',   marketId:3, override:{num:1, den:1}, priceUSD:36  },
  { key:'ko_usd',   id:6059, name:'COCA-COLA CO',        marketId:3, override:{num:1, den:1}, priceUSD:59  },
  { key:'mcd_usd',  id:6068, name:"MCDONALD'S CORP",     marketId:3, override:{num:1, den:1}, priceUSD:260 },
  { key:'msft_usd', id:6001, name:'MICROSOFT CORP',      marketId:3, override:{num:1, den:1}, priceUSD:420 },
  { key:'ibm_usd',  id:6066, name:'IBM',                 marketId:3, override:{num:1, den:1}, priceUSD:205 },
  { key:'meta_usd', id:6006, name:'META PLATFORMS INC.', marketId:3, override:{num:1, den:1}, priceUSD:490 },
  { key:'nvda_usd', id:6002, name:'NVIDIA CORP',         marketId:3, override:{num:1, den:1}, priceUSD:1200 },
  { key:'tsla_usd', id:6000, name:'TESLA INC',           marketId:3, override:{num:1, den:1}, priceUSD:240 },
  { key:'orcle_usd',id:6038, name:'ORACLE CORPORATION',  marketId:3, override:{num:1, den:1}, priceUSD:140 }
];

/* =========================
   CONFIG (adapte si besoin)
========================= */
// Oracle feed (Atlantic)
const RPC_URL    = 'https://atlantic.dplabs-internal.com';
const FEED_ADDR  = '0x26524d23f70fbb17c8d5d5c3353a9693565b9be0'.toLowerCase();

// API
const API_BASE   = 'https://api.brokex.trade';

// Executor
const EXECUTOR_PATH = 'executor.js';
const EXECUTOR_ADDR = process.env.EXECUTOR_ADDR || '0x04a7cdf3b3aff0a0f84a94c48095d84baa91ec11'; // <-- mets l'addr ici ou via env
const EXECUTOR_RPC  = process.env.RPC_URL || RPC_URL; // tu peux passer --rpc si tu préfères

// Logique
const RANGE_RATE    = 0.0002;   // ±0.02%
const MAX_IDS       = 200;      // batch size
const CALL_DELAY_MS = 1000;     // 1s entre batches
const RUN_SECONDS   = [3, 15, 27, 39, 51];

/* =========================
   Per-asset Private Keys
   - Remplis ici, ex: { 0:'0x...', 1:'0x...', 5002:'0x...' }
   - OU exporte dans l'environnement: PK_<assetId>=0x...
   - Fallback: process.env.PRIVATE_KEY (à éviter si tu veux strictement par actif)
========================= */
const ASSET_PKS = {
  // 0: '0xYOUR_PK_FOR_BTC',
  // 1: '0xYOUR_PK_FOR_ETH',
  // 5002: '0xYOUR_PK_FOR_GBP_USD',
};

/* =========================
   Ethers
========================= */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const FEED_ABI = [
  'function getSvalues(uint256[] _pairIndexes) view returns (tuple(uint256 round,uint256 decimals,uint256 time,uint256 price)[] out)'
];
const feed = new ethers.Contract(FEED_ADDR, FEED_ABI, provider);

/* =========================
   Utils
========================= */
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const uniqSortedIds = (arr) => Array.from(new Set(arr.map(Number)))
  .filter(n => Number.isFinite(n) && n >= 0)
  .sort((a, b) => a - b);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

function getPkForAsset(assetId) {
  // priorité: ASSET_PKS > env PK_<id> > env PRIVATE_KEY
  if (ASSET_PKS[assetId]) return ASSET_PKS[assetId];
  if (process.env[`PK_${assetId}`]) return process.env[`PK_${assetId}`];
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY; // fallback (optionnel)
  return null;
}

/* =========================
   Executor wrapper
   -> passe la clé privée en positionnel (3e arg) comme demandé
========================= */
async function runExecutor(mode, { assetId, ids, pk }) {
  if (!ids?.length) return;
  if (!pk) {
    log(`[executor] ⚠️ pas de PK pour asset ${assetId}, skip.`);
    return;
  }

  const batches = chunk(ids, MAX_IDS);
  for (const group of batches) {
    const argIds = JSON.stringify(group); // "[..]"
    // executor.js: mode, ids, <PRIVATE_KEY>, flags...
    const args = [
      EXECUTOR_PATH,
      mode,
      argIds,
      pk,
      `--asset=${assetId}`,
      `--addr=${EXECUTOR_ADDR}`,
      `--rpc=${EXECUTOR_RPC}`
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
   Per-asset cycle
========================= */
const runningByAsset = new Set();

async function runOnceForAsset(asset) {
  const assetId = asset.id;
  if (runningByAsset.has(assetId)) return; // anti-overlap par actif
  runningByAsset.add(assetId);
  try {
    // 1) Oracle (pairIndex = asset.id)
    const out = await feed.getSvalues([BigInt(assetId)]);
    if (!out || !out[0]) {
      log(`[trigger] ⚠️ getSvalues vide pour asset=${assetId}.`);
      return;
    }
    const { price, decimals } = out[0];
    const priceHuman = Number(price) / (10 ** Number(decimals));
    log(`[trigger] 🔔 asset=${assetId} (${asset.key}) → price=${priceHuman} (decimals=${decimals})`);

    // 2) API range ±0.02 %
    const from = priceHuman * (1 - RANGE_RATE);
    const to   = priceHuman * (1 + RANGE_RATE);
    const url  = `${API_BASE}/bucket/range?asset=${assetId}&from=${from}&to=${to}&types=orders,stops&side=all&sort=lots&order=desc`;
    const data = await fetchJson(url);

    const ORDERS = Array.isArray(data.items_orders) ? data.items_orders : [];
    const STOPS  = Array.isArray(data.items_stops)  ? data.items_stops  : [];

    const orderIds = uniqSortedIds(ORDERS.map(o => o.id));
    const stopsSL  = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase()==='SL').map(s => s.id));
    const stopsTP  = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase()==='TP').map(s => s.id));
    const stopsLIQ = uniqSortedIds(STOPS.filter(s => String(s.type).toUpperCase()==='LIQ').map(s => s.id));

    log(`[trigger] ✅ asset=${assetId} → ORDERS=${orderIds.length}, SL=${stopsSL.length}, TP=${stopsTP.length}, LIQ=${stopsLIQ.length}`);

    const pk = getPkForAsset(assetId);

    // 3) Envois (séquentiel par actif)
    if (orderIds.length) await runExecutor('limit', { assetId, ids: orderIds, pk });
    if (stopsSL.length)  await runExecutor('sl',    { assetId, ids: stopsSL,  pk });
    if (stopsTP.length)  await runExecutor('tp',    { assetId, ids: stopsTP,  pk });
    if (stopsLIQ.length) await runExecutor('liq',   { assetId, ids: stopsLIQ, pk });

  } catch (e) {
    log(`[trigger] 💥 asset=${asset.id} error:`, e?.shortMessage || e?.message || String(e));
  } finally {
    runningByAsset.delete(assetId);
  }
}

/* =========================
   Scheduler (3,15,27,39,51 s)
   -> lance TOUS les actifs simultanément
========================= */
function startScheduler() {
  log(`[trigger] 🕒 Scheduler (secs=${RUN_SECONDS.join(',')}) | RPC=${RPC_URL} | FEED=${FEED_ADDR}`);
  let lastSecond = -1;
  setInterval(() => {
    const now = new Date();
    const sec = now.getSeconds();
    if (sec === lastSecond) return;
    lastSecond = sec;
    if (RUN_SECONDS.includes(sec)) {
      Promise.allSettled(ASSETS.map(runOnceForAsset))
        .then(() => log('[trigger] ✅ tick terminé (all assets)'))
        .catch((e) => log('[trigger] 💥 tick error:', e?.message || String(e)));
    }
  }, 250);
}

startScheduler();
