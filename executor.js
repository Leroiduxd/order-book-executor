// executor.js
import 'dotenv/config';
import { ethers } from 'ethers';

/* =========================================
   CONFIG (via .env ou flags CLI)
========================================= */
const DEFAULT_RPC  = process.env.RPC_URL || 'https://testnet.dplabs-internal.com';
const DEFAULT_PK   = process.env.PRIVATE_KEY || '';
const DEFAULT_ADDR = process.env.EXECUTOR_ADDR; // obligatoire (ou --addr)

/* =========================================
   ABIs — avec retours ET sans retours
========================================= */
const ABI32 = [
  'function execLimits(uint32 assetId, uint32[] ids) returns (uint32 executed, uint32 skipped)',
  'function closeBatch(uint32 assetId, uint8 reason, uint32[] ids) returns (uint32 closed, uint32 skipped)',
];
const ABI256 = [
  'function execLimits(uint32 assetId, uint256[] ids) returns (uint32 executed, uint32 skipped)',
  'function closeBatch(uint32 assetId, uint8 reason, uint256[] ids) returns (uint32 closed, uint32 skipped)',
];
const ABI32_NORET = [
  'function execLimits(uint32 assetId, uint32[] ids)',
  'function closeBatch(uint32 assetId, uint8 reason, uint32[] ids)',
];
const ABI256_NORET = [
  'function execLimits(uint32 assetId, uint256[] ids)',
  'function closeBatch(uint32 assetId, uint8 reason, uint256[] ids)',
];

/* =========================================
   CLI Helpers
========================================= */
function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v = 'true'] = a.slice(2).split('=');
      flags[k] = v;
    }
  }
  return flags;
}
function parseIds(raw) {
  if (!raw) throw new Error('IDs manquants. Ex: "[123,329]" ou "123,329"');
  const s = String(raw).trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('Format JSON attendu: [1,2,3]');
    return sanitizeIds(arr);
  }
  return sanitizeIds(s.split(',').map(x => x.trim()).filter(Boolean));
}
function sanitizeIds(arr) {
  const out = arr.map(x => {
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new Error(`ID invalide: ${x} (entier attendu)`);
    }
    return n;
  });
  if (out.length === 0) throw new Error('Aucun ID valide fourni');
  return Array.from(new Set(out)).sort((a,b)=>a-b);
}
function reasonFromMode(mode) {
  switch (mode) {
    case 'sl':  return 1;
    case 'tp':  return 2;
    case 'liq': return 3;
    default:    return null;
  }
}

/* =========================================
   Ethers compat v5/v6 + decode erreurs
========================================= */
function isV6() {
  try { return !!ethers?.Contract && !!ethers?.isAddress && !!ethers?.JsonRpcProvider; } catch { return false; }
}
function getProvider(rpcUrl) {
  if (isV6()) return new ethers.JsonRpcProvider(rpcUrl);
  // @ts-ignore v5
  return new ethers.providers.JsonRpcProvider(rpcUrl);
}
function hexToAscii(hex) {
  try {
    const h = hex.replace(/^0x/, '');
    return Buffer.from(h, 'hex').toString('utf8');
  } catch { return ''; }
}
function tryDecodeRevert(err) {
  const cands = [
    err?.data,
    err?.error?.data,
    err?.info?.error?.data,
    err?.info?.error?.message,
    err?.shortMessage,
    err?.message
  ].filter(Boolean);
  for (const raw of cands) {
    if (typeof raw === 'string' && raw.startsWith('0x')) {
      // Error(string) selector 0x08c379a0
      if (raw.startsWith('0x08c379a0') && raw.length >= (10 + 64 + 64)) {
        // skip selector (4 bytes -> 8 hex + '0x' => 10), then skip offset (64), then next 64 is length, then data
        // Quick decode best-effort:
        const strHex = '0x' + raw.slice(10 + 64*2); // rough slice to message
        const msg = hexToAscii(strHex);
        if (msg) return `Error(string): ${msg}`;
      }
      return `(raw) ${raw}`;
    }
    if (typeof raw === 'string') return raw;
  }
  return '(no revert message)';
}

/* simulate/callStatic compatible v5/v6 */
async function simulateOrStatic(contract, fn, args) {
  // v6: contract.simulate.fn(...)
  if (contract.simulate && typeof contract.simulate[fn] === 'function') {
    const sim = await contract.simulate[fn](...args);
    // v6 returns an object with .result array-like
    const arr = Array.from(sim?.result ?? []);
    return arr;
  }
  // v5: contract.callStatic.fn(...)
  // @ts-ignore
  if (contract.callStatic && typeof contract.callStatic[fn] === 'function') {
    // @ts-ignore
    const res = await contract.callStatic[fn](...args);
    return Array.from(res ?? []);
  }
  // Fallback: raw eth_call
  const iface = contract.interface || (new ethers.Interface(contract.fragments));
  const data = iface.encodeFunctionData(fn, args);
  const runner = contract.runner || contract.provider;
  const ret = await runner.call({ to: contract.target || contract.address, data });
  const decoded = iface.decodeFunctionResult(fn, ret);
  return Array.from(decoded ?? []);
}

/* Essaye 4 variantes d'ABI dans l'ordre:
   1) uint32[] avec retours
   2) uint256[] avec retours
   3) uint32[] sans retours
   4) uint256[] sans retours
*/
async function withAnyAbi(provider, wallet, address, runner, fnName, args) {
  const tryWith = async (abi, expectReturn, label) => {
    const cRun = new ethers.Contract(address, abi, runner);
    if (expectReturn) {
      const res = await simulateOrStatic(cRun, fnName, args); // peut throw si decode impossible
      return { which: label, contract: new ethers.Contract(address, abi, wallet), sim: res, expectReturn: true };
    } else {
      // simple eth_call pour s'assurer que ça ne revert pas (on ne décode pas de retour)
      const iface = new ethers.Interface(abi);
      const data = iface.encodeFunctionData(fnName, args);
      await runner.call({ to: address, data }); // si ça revert -> throw
      return { which: label, contract: new ethers.Contract(address, abi, wallet), sim: [], expectReturn: false };
    }
  };

  try { return await tryWith(ABI32, true,  'uint32[] (ret)'); } catch {}
  try { return await tryWith(ABI256, true, 'uint256[] (ret)'); } catch {}
  try { return await tryWith(ABI32_NORET, false, 'uint32[] (noret)'); } catch {}
  return await tryWith(ABI256_NORET, false, 'uint256[] (noret)');
}

/* =========================================
   MAIN
========================================= */
async function main() {
  const argv = process.argv.slice(2);
  const mode = (argv[0] || '').toLowerCase(); // "limit" | "sl" | "tp" | "liq"
  const idsArg = argv[1];
  const flags = parseFlags(argv.slice(2));

  if (!['limit', 'sl', 'tp', 'liq'].includes(mode)) {
    console.error('Usage:');
    console.error('  node executor.js limit "[123,329]" [--asset=0] [--addr=0x...] [--rpc=...] [--pk=...]');
    console.error('  node executor.js sl    "123,329"   [...]   (reason=1)');
    console.error('  node executor.js tp    "[1,2,3]"   [...]   (reason=2)');
    console.error('  node executor.js liq   "1,2,3"     [...]   (reason=3)');
    process.exit(1);
  }

  const idsRaw = parseIds(idsArg);
  const assetId = flags.asset !== undefined ? Number(flags.asset) : (Number(process.env.ASSET_ID) || 0);
  if (!Number.isInteger(assetId) || assetId < 0) throw new Error('Paramètre --asset invalide');

  const RPC_URL = flags.rpc || DEFAULT_RPC;
  const PRIVATE_KEY = flags.pk || DEFAULT_PK;
  const EXECUTOR_ADDR = flags.addr || DEFAULT_ADDR;
  if (!EXECUTOR_ADDR) throw new Error('Adresse du contrat manquante. --addr=0x... ou EXECUTOR_ADDR dans .env');
  if (!PRIVATE_KEY)  throw new Error('Clé privée manquante. --pk=0x... ou PRIVATE_KEY dans .env');

  const provider = getProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log('🔗 RPC:', RPC_URL);
  console.log('👤 Wallet:', wallet.address);
  console.log('⚙️  Contract:', EXECUTOR_ADDR);
  console.log('📦 Mode:', mode, '| Asset:', assetId, '| IDs:', idsRaw.join(','));
  console.log('🧭 Ethers version:', (ethers.version || 'unknown'));

  try {
    if (mode === 'limit') {
      // Détection ABI + simulate
      const { which, contract, sim, expectReturn } =
        await withAnyAbi(provider, wallet, EXECUTOR_ADDR, provider, 'execLimits', [assetId, idsRaw]);

      console.log(`🧪 ABI détectée pour execLimits: ${which}`);
      if (expectReturn) {
        const [executedSim = 0, skippedSim = 0] = sim;
        console.log(`🧠 simulate.execLimits → executed=${Number(executedSim)} | skipped=${Number(skippedSim)}`);
      } else {
        console.log('🧠 simulate.execLimits → OK (no-return ABI)');
      }

      const tx = await contract.execLimits(assetId, idsRaw);
      console.log('🚀 execLimits tx:', tx.hash || tx);
      const rc = await (tx.wait ? tx.wait() : provider.waitForTransaction(tx.hash));
      console.log('✅ execLimits confirmed in block', rc.blockNumber);
      return;
    }

    // SL / TP / LIQ via closeBatch(reason)
    const reason = reasonFromMode(mode);
    if (reason == null) throw new Error('Reason inconnu (sl|tp|liq)');

    const { which, contract, sim, expectReturn } =
      await withAnyAbi(provider, wallet, EXECUTOR_ADDR, provider, 'closeBatch', [assetId, reason, idsRaw]);

    console.log(`🧪 ABI détectée pour closeBatch: ${which}`);
    if (expectReturn) {
      const [closedSim = 0, skippedSim = 0] = sim;
      console.log(`🧠 simulate.closeBatch(${reason}) → closed=${Number(closedSim)} | skipped=${Number(skippedSim)}`);
    } else {
      console.log(`🧠 simulate.closeBatch(${reason}) → OK (no-return ABI)`);
    }

    const tx2 = await contract.closeBatch(assetId, reason, idsRaw);
    console.log('🚀 closeBatch tx:', tx2.hash || tx2);
    const rc2 = await (tx2.wait ? tx2.wait() : provider.waitForTransaction(tx2.hash));
    console.log('✅ closeBatch confirmed in block', rc2.blockNumber);

  } catch (err) {
    console.error('💥 Error:', tryDecodeRevert(err));
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('❌ Fatal:', e?.message || e);
  process.exit(1);
});
