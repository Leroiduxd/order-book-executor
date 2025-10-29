// executor.js
import 'dotenv/config';
import { ethers } from 'ethers';

/* =========================
   CONFIG
========================= */
const DEFAULT_RPC = process.env.RPC_URL || 'https://atlantic.dplabs-internal.com';
const DEFAULT_PK  = process.env.PRIVATE_KEY || '0xe12f9b03327a875c2d5bf9b40a75cd2effeed46ea508ee595c6bc708c386da8c';
const DEFAULT_ADDR = process.env.EXECUTOR_ADDR; // à mettre dans .env ou via --addr

/* =========================
   ABIs (on tente uint32[] puis uint256[])
========================= */
const ABI32 = [
  'function execLimits(uint32 assetId, uint32[] ids) returns (uint32 executed, uint32 skipped)',
  'function closeBatch(uint32 assetId, uint8 reason, uint32[] ids) returns (uint32 closed, uint32 skipped)',
];

const ABI256 = [
  'function execLimits(uint32 assetId, uint256[] ids) returns (uint32 executed, uint32 skipped)',
  'function closeBatch(uint32 assetId, uint8 reason, uint256[] ids) returns (uint32 closed, uint32 skipped)',
];

/* =========================
   CLI PARSING
========================= */
function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v = 'true'] = a.slice(2).split('=');
    flags[k] = v;
  }
  return flags;
}

function parseIds(raw) {
  if (!raw) throw new Error('IDs manquants. Ex: "[123,329]" ou "123,329"');
  let s = String(raw).trim();

  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) throw new Error('Format JSON attendu: [1,2,3]');
      return sanitizeIds(arr);
    } catch {
      throw new Error('Impossible de parser les IDs (JSON).');
    }
  }
  return sanitizeIds(
    s.split(',').map((x) => x.trim()).filter(Boolean)
  );
}

function sanitizeIds(arr) {
  const out = arr.map((x) => {
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new Error(`ID invalide: ${x} (entier attendu)`);
    }
    // on garde Number, on adaptera selon ABI (uint32 vs uint256)
    return n;
  });
  if (out.length === 0) throw new Error('Aucun ID valide fourni');
  return out;
}

function reasonFromMode(mode) {
  switch (mode) {
    case 'sl':  return 1;
    case 'tp':  return 2;
    case 'liq': return 3;
    default:    return null;
  }
}

/* =========================
   ETHERS v5/v6 helpers
========================= */
function isV6(ethersMod) {
  // v6 expose ethers.version comme "6.x.x" et a ethers.isAddress
  try { return !!ethersMod?.Contract && !!ethersMod?.isAddress; } catch { return false; }
}

async function simulateOrStatic(contract, fn, args) {
  // v6: contract.simulate.fn(...), v5: contract.callStatic.fn(...)
  if (contract.simulate && typeof contract.simulate[fn] === 'function') {
    const sim = await contract.simulate[fn](...args);
    // v6 -> sim.result (array-like)
    return Array.from(sim.result ?? []);
  }
  if (contract.callStatic && typeof contract.callStatic[fn] === 'function') {
    const res = await contract.callStatic[fn](...args);
    // v5 -> res est déjà un array-like
    return Array.from(res ?? []);
  }
  // Au pire: essai via provider.call manuelle
  const iface = contract.interface;
  const data = iface.encodeFunctionData(fn, args);
  const call = await contract.runner.call({ to: contract.target, data });
  const decoded = iface.decodeFunctionResult(fn, call);
  return Array.from(decoded ?? []);
}

/* Essaye d'abord ABI32, sinon ABI256 */
async function withAnyAbi(provider, wallet, address, runner, fnName, args) {
  const c32 = new ethers.Contract(address, ABI32, runner);
  try {
    const out = await simulateOrStatic(c32, fnName, args);
    return { which: 'uint32[]', contract: new ethers.Contract(address, ABI32, wallet), sim: out };
  } catch (e1) {
    const c256 = new ethers.Contract(address, ABI256, runner);
    const out = await simulateOrStatic(c256, fnName, args);
    return { which: 'uint256[]', contract: new ethers.Contract(address, ABI256, wallet), sim: out };
  }
}

/* =========================
   MAIN
========================= */
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

  const provider = new ethers.JsonRpcProvider ? new ethers.JsonRpcProvider(RPC_URL) : new ethers.providers.JsonRpcProvider(RPC_URL);
  // v6: ethers.Wallet(priv, provider) ; v5: idem
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log('🔗 RPC:', RPC_URL);
  console.log('👤 Wallet:', wallet.address);
  console.log('⚙️  Contract:', EXECUTOR_ADDR);
  console.log('📦 Mode:', mode, '| Asset:', assetId, '| IDs:', idsRaw.join(','));
  console.log('🧭 Ethers version:', (ethers.version || 'unknown'));

  try {
    if (mode === 'limit') {
      // Test ABI + simulate
      const { which, contract, sim } = await withAnyAbi(provider, wallet, EXECUTOR_ADDR, provider, 'execLimits', [assetId, idsRaw]);
      const [executedSim = 0, skippedSim = 0] = sim;
      console.log(`🧪 ABI détectée pour execLimits: ${which}`);
      console.log(`🧠 simulate.execLimits → executed=${executedSim} | skipped=${skippedSim}`);

      // Envoi réel
      const tx = await contract.execLimits(assetId, idsRaw);
      console.log('🚀 execLimits tx:', tx.hash || tx);
      const rc = await (tx.wait ? tx.wait() : provider.waitForTransaction(tx.hash));
      console.log('✅ execLimits confirmed in block', rc.blockNumber);
      return;
    }

    // sl/tp/liq via closeBatch(reason)
    const reason = reasonFromMode(mode);
    if (!reason) throw new Error('Reason inconnu');

    const { which, contract, sim } = await withAnyAbi(provider, wallet, EXECUTOR_ADDR, provider, 'closeBatch', [assetId, reason, idsRaw]);
    const [closedSim = 0, skippedSim = 0] = sim;
    console.log(`🧪 ABI détectée pour closeBatch: ${which}`);
    console.log(`🧠 simulate.closeBatch(${reason}) → closed=${closedSim} | skipped=${skippedSim}`);

    const tx2 = await contract.closeBatch(assetId, reason, idsRaw);
    console.log('🚀 closeBatch tx:', tx2.hash || tx2);
    const rc2 = await (tx2.wait ? tx2.wait() : provider.waitForTransaction(tx2.hash));
    console.log('✅ closeBatch confirmed in block', rc2.blockNumber);

  } catch (err) {
    console.error('💥 Error:', err?.shortMessage || err?.reason || err?.message || err);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('❌ Fatal:', e?.message || e);
  process.exit(1);
});
