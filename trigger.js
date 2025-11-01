// trigger.js — multi-assets, per-asset PK, parallel execution + verify on skipped
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
const API_BASE    = 'https://api.brokex.trade';
const VERIFY_BASE = API_BASE; // même host

// Executor
const EXECUTOR_PATH = 'executor.js';
const EXECUTOR_ADDR = process.env.EXECUTOR_ADDR || '0x04a7cdf3b3aff0a0f84a94c48095d84baa91ec11';
const EXECUTOR_RPC  = process.env.RPC_URL || RPC_URL;

// Logique
const RANGE_RATE    = 0.0002;   // ±0.02%
const MAX_IDS       = 200;      // batch size
const CALL_DELAY_MS = 1000;     // 1s entre batches
const RUN_SECONDS   = [3, 15, 27, 39, 51];

/* =========================
   Per-asset Private Keys
========================= */
const ASSET_PKS = {
  0:  '0x30e6b5a4b85aa2546c14126ae90ccd111d9a2a0ebea2d1054927fbcfc0bae679',
  1:  '0x1fbf77e7f80bbc62a6d9e5f48c53a9b0fdf5a3d319bc4f82ebd6c1900a39b8cf',
  10: '0x73764c6c4db59b05a7c047be299fc3d0a7e946f7d0924ee8e79bc813f03a8390',
  14: '0x858d92c9f08a6173296a8530119a2c2717e57deef766b1d37ed7cdec843b5a34',
  5:  '0x6f5a670511d2b0df838429b9a55b9187e0dfcc7dbddd1413c7addf3e6eb890e1',
  3:  '0xefd4833a9223aeadb4a0920626b1decfeba0eea6dcc2fce2b822aebeba5ce38a',
  15: '0xf0224de9accb50482163861bd6494ca926e1fd12a0315070bd5baf986e888280',
  16: '0x13b8780805c50c8f6c0e88020aa8bae32444b0844e886160dde3f64f2a25d33a',
  90: '0x2f3095bbe2e0e2b4d4821f668b4edd16f93057c1673df65d762410096344b2b9',
  2:  '0x4f963ab7fa45ff630cb6bcedf1b46e996a158214161fd982e40f987a5718a2c2',
  5010: '0x9b2869e965d495b437ac39b80b880ee4ccd937c90003136cffd2d4daaa3ed2a3',
  5000: '0xa0ba7957bf03c1bf540c3c054136dd757e10653132290e18a80f5155d2015923',
  5002: '0x1cc1b15a63c39e705dcbe33e8d5e537ab3c98162928dd0b90409e542fff7ffe7',
  5013: '0xbcdf2289d1cc95cce21a612bacfc6f3f421b8932260bac291d06de89e411fbf7',
  5011: '0x377e9dc62a6cac94dbe2bf8ee42e1b67ec87af433aed9dd35dbb6812ce2cb8ef',
  5012: '0x9688709ad6a5e5d479420522e2d98b143f3016a907bc12e837b597c3c7e30936',
  5001: '0x07230cdac2d9527fe0dba37b65cfba502787a61b0537954136b4e10377a0424e',
  5501: '0x5f5c813fc653025604377fbc4a9607d36e0b24b9c8bee9e1f20a8dc867b93063',
  5500: '0x47c6a29d549627dbe2a08d117663db865f8cb832a2b7bafea5e58328c49763ce',
  5503: '0x31bdd848d64e471ff0c3f1045c71bdf07aaff3c6abe33ec8129e3bd0536ec0b0',
  6113: '0xd874c3b4ada4d76389a4ba6209fe713fe98a1199e7ceb6addbf543866cca379e',
  6114: '0x1e11e53e46013dd394862f88b35d9ae7832c89eb8c2e8183734f61163e785b20',
  6115: '0x1844472ac350150243541a2adf0c5685d8320336a73e66aba4301b94ec405b04',
  6004: '0xa24112c51b5d4e45fc68722912b3e07202ee6355abd9f2011b5d68522fc597b4',
  6005: '0x2d2c6e4d5f6e4981b8f20bbbd7e842c75046086c24ed15b3ae8f52eca79a5689',
  6010: '0xd74e3b4e10e90a5b47c837def4df6dfdbe1ba04d388261a53bc7f43ae781b7f1',
  6003: '0x093478581c2234729881d7c55c6eba32611c1cdb805ff471af7e586a9bef4069',
  6011: '0x8d47ba8bc3005d83e0f458ae8437aff9d0a3c0b1fcf54065a27a7636680efc6c',
  6009: '0xf847ca3728d61dc07364f1a8b168375dee8af75153954f691b6fb54c58116efc',
  6059: '0xcd9c28caa26d3cb44ed263cc662483f2435919c71914d0d366117a552952a95e',
  6068: '0xbbe097328882cfd1ba30e7fea0f7554856fd8898d4d00e52a03db17f41ff87ca',
  6001: '0x526ad8260f1772b8e337557246d95d04c25df80da4cd16713d739264a2488c6d',
  6066: '0x1707c9060a0bf84b9261768bd441ea7abf52f383100b1d04e383c5ccd28a3215',
  6006: '0xf74276de3dfe1f111738b996f2b4adee74f1be17c0e1edf5dd4f0b2ddefd505b',
  6002: '0xc6bad8c4d6d2dc1372cef68a23e9e00cac28456af94c49c91c6757452f733639',
  6000: '0xd46075b5bca9cf2feb1e461a18a56390f6d31bcbfec6f01e0d41d80d2444211f',
  6038: '0x25bcf46e8326e83709c955290a1f4db09840e2ee59c1936142375c1f4057f289',
};

/* =========================
   Ethers & oracle feed
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
  if (ASSET_PKS[assetId]) return ASSET_PKS[assetId];
  if (process.env[`PK_${assetId}`]) return process.env[`PK_${assetId}`];
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  return null;
}

/* =========================
   Verify caller
========================= */
async function callVerify(ids) {
  if (!ids?.length) return;
  const url = `${VERIFY_BASE}/verify/${ids.join(',')}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log(`[verify] HTTP ${res.status} ${res.statusText} :: ${txt}`);
      return;
    }
    const json = await res.json().catch(() => ({}));
    log(`[verify] ✅ ${url} → ${JSON.stringify(json)}`);
  } catch (e) {
    log(`[verify] 💥 ${url} → ${e?.message || String(e)}`);
  }
}

/* =========================
   Executor wrapper
   -> capture stdout/stderr, parse "simulate.* → skipped=K"
   -> si skipped>0 => callVerify(batchIds)
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
    const args = [
      EXECUTOR_PATH,
      mode,
      argIds,
      pk,
      `--asset=${assetId}`,
      `--addr=${EXECUTOR_ADDR}`,
      `--rpc=${EXECUTOR_RPC}`
    ];

    let out = '';
    let err = '';
    let skippedSim = 0;

    await new Promise((resolve, reject) => {
      const p = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      p.stdout.on('data', (buf) => {
        const s = buf.toString();
        out += s;
        process.stdout.write(s);
      });
      p.stderr.on('data', (buf) => {
        const s = buf.toString();
        err += s;
        process.stderr.write(s);
      });

      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${mode} exit ${code}`))));
      p.on('error', reject);
    }).catch((e) => {
      log(`[executor] 💥 ${mode} error:`, e?.message || String(e));
      skippedSim = group.length; // prudence: tout vérifier si l’exec a échoué
    });

    try {
      const m1 = out.match(/simulate\.execLimits\s*→\s*executed=(\d+)\s*\|\s*skipped=(\d+)/);
      const m2 = out.match(/simulate\.closeBatch\(\d+\)\s*→\s*closed=(\d+)\s*\|\s*skipped=(\d+)/);
      if (m1) skippedSim = Number(m1[2] || 0);
      if (m2) skippedSim = Number(m2[2] || 0);
    } catch { /* noop */ }

    if (skippedSim > 0) {
      log(`[executor] 🔎 skipped=${skippedSim} → verify(${group.length} ids)`);
      await callVerify(group);
    }

    await sleep(CALL_DELAY_MS);
  }
}

/* =========================
   Per-asset cycle
========================= */
const runningByAsset = new Set();

async function runOnceForAsset(asset) {
  const assetId = asset.id;
  if (runningByAsset.has(assetId)) return;
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
