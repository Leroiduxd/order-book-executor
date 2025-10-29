// executor.js
import 'dotenv/config';
import { ethers } from 'ethers';

/* =========================
   CONFIG (env + flags)
========================= */
const DEFAULT_RPC = process.env.RPC_URL || 'https://testnet.dplabs-internal.com';
const DEFAULT_PK  = process.env.PRIVATE_KEY || '';
const DEFAULT_ADDR = process.env.EXECUTOR_ADDR || '';

/* =========================
   ABIs
========================= */
// Avec retours (uint32/uint256)
const ABI32 = [
  'function execLimits(uint32 assetId, uint32[] ids) returns (uint32 executed, uint32 skipped)',
  'function closeBatch(uint32 assetId, uint8 reason, uint32[] ids) returns (uint32 closed, uint32 skipped)',
];
const ABI256 = [
  'function execLimits(uint32 assetId, uint256[] ids) returns (uint32 executed, uint32 skipped)',
  'function closeBatch(uint32 assetId, uint8 reason, uint256[] ids) returns (uint32 closed, uint32 skipped)',
];
// Sans retours (fallback si le nœud/contrat ne renvoie pas de valeurs)
const ABI32_NR = [
  'function execLimits(uint32 assetId, uint32[] ids)',
  'function closeBatch(uint32 assetId, uint8 reason, uint32[] ids)',
];
const ABI256_NR = [
  'function execLimits(uint32 assetId, uint256[] ids)',
  'function closeBatch(uint32 assetId, uint8 reason, uint256[] ids)',
];

/* =========================
   CLI helpers
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
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('Format JSON attendu: [1,2,3]');
    return sanitizeIds(arr);
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
    return n;
  });
  if (out.length === 0) throw new Error('Aucun ID valide fourni');
  // tri + dédoublonnage (souvent requis on-chain)
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

/* =========================
   Ethers helpers
========================= */
async function simulateOrStatic(contract, fn, args) {
  // v6: contract.simulate.fn(...), v5: contract.callStatic.fn(...)
  if (contract.simulate && typeof contract.simulate[fn] === 'function') {
    const sim = await contract.simulate[fn](...args);
    return Array.from(sim.result ?? []);
  }
  if (contract.callStatic && typeof contract.callStatic[fn] === 'function') {
    const res = await contract.callStatic[fn](...args);
    return Array.from(res ?? []);
  }
  // fallback ultra-compat
  const iface = contract.interface;
  const data = iface.encodeFunctionData(fn, args);
  const call = await contract.runner.call({ to: contract.target, data });
  const decoded = iface.decodeFunctionResult(fn, call);
  return Array.from(decoded ?? []);
}

// Sélection d'ABI avec tolérance aux contrats qui ne renvoient rien
async function pickAbi(provider, wallet, address, runner, fnName, args) {
  // 1) Essai ABI32 avec retours
  try {
    const c = new ethers.Contract(address, ABI32, runner);
    const out = await simulateOrStatic(c, fnName, args);
    return { abi: '32-ret', contract: new ethers.Contract(address, ABI32, wallet), sim: out };
  } catch (e1) {}

  // 2) Essai ABI256 avec retours
  try {
    const c = new ethers.Contract(address, ABI256, runner);
    const out = await simulateOrStatic(c, fnName, args);
    return { abi: '256-ret', contract: new ethers.Contract(address, ABI256, wallet), sim: out };
  } catch (e2) {}

  // 3) Fallback: ABI32 sans retours
  try {
    const c = new ethers.Contract(address, ABI32_NR, wallet);
    return { abi: '32-noret', contract: c, sim: null };
  } catch (e3) {}

  // 4) Fallback: ABI256 sans retours
  const c = new ethers.Contract(address, ABI256_NR, wallet);
  return { abi: '256-noret', contract: c, sim: null };
}

async function sendNoReturn(contract, fn, args) {
  const tx = await contract[fn](...args);
  console.log('🚀', fn, 'tx:', tx.hash || tx);
  const rc = await (tx.wait ? tx.wait() : contract.runner.waitForTransaction(tx.hash));
  console.log('✅', fn, 'confirmed in block', rc.blockNumber);
  return { ok: true };
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
    console.error('  node executor.js sl    "1,2,3"     (reason=1)');
    console.error('  node executor.js tp    "[4,5,6]"   (reason=2)');
    console.error('  node executor.js liq   "7,8"       (reason=3)');
    process.exit(1);
  }

  const idsRaw = parseIds(idsArg);
  const assetId = flags.asset !== undefined ? Number(flags.asset) : (Number(process.env.ASSET_ID) || 0);
  if (!Number.isInteger(assetId) || assetId < 0) throw new Error('Paramètre --asset invalide');

  const RPC_URL = flags.rpc || DEFAULT_RPC;
  const PRIVATE_KEY = flags.pk || DEFAULT_PK;
  const EXECUTOR_ADDR = flags.addr || DEFAULT_ADDR;
  if (!RPC_URL) throw new Error('RPC_URL manquant (env ou --rpc)');
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY manquante (env ou --pk)');
  if (!EXECUTOR_ADDR) throw new Error('EXECUTOR_ADDR manquante (env ou --addr)');

  // ethers v6 provider & wallet
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log('🔗 RPC:', RPC_URL);
  console.log('👤 Wallet:', wallet.address);
  console.log('⚙️  Contract:', EXECUTOR_ADDR);
  console.log('📦 Mode:', mode, '| Asset:', assetId, '| IDs:', idsRaw.join(','));
  console.log('🧭 Ethers version:', (ethers.version || 'unknown'));

  try {
    if (mode === 'limit') {
      const pick = await pickAbi(provider, wallet, EXECUTOR_ADDR, provider, 'execLimits', [assetId, idsRaw]);

      if (pick.sim) {
        const [executedSim = 0, skippedSim = 0] = pick.sim;
        console.log(`🧪 ABI détectée pour execLimits: ${pick.abi}`);
        console.log(`🧠 simulate.execLimits → executed=${executedSim} | skipped=${skippedSim}`);
        const tx = await pick.contract.execLimits(assetId, idsRaw);
        console.log('🚀 execLimits tx:', tx.hash || tx);
        const rc = await (tx.wait ? tx.wait() : provider.waitForTransaction(tx.hash));
        console.log('✅ execLimits confirmed in block', rc.blockNumber);
      } else {
        console.log(`🧪 ABI détectée pour execLimits: ${pick.abi} (no return)`);
        await sendNoReturn(pick.contract, 'execLimits', [assetId, idsRaw]);
      }
      return;
    }

    // sl/tp/liq via closeBatch(reason)
    const reason = reasonFromMode(mode);
    if (!reason) throw new Error('Reason inconnu');

    const pick = await pickAbi(provider, wallet, EXECUTOR_ADDR, provider, 'closeBatch', [assetId, reason, idsRaw]);

    if (pick.sim) {
      const [closedSim = 0, skippedSim = 0] = pick.sim;
      console.log(`🧪 ABI détectée pour closeBatch: ${pick.abi}`);
      console.log(`🧠 simulate.closeBatch(${reason}) → closed=${closedSim} | skipped=${skippedSim}`);
      const tx2 = await pick.contract.closeBatch(assetId, reason, idsRaw);
      console.log('🚀 closeBatch tx:', tx2.hash || tx2);
      const rc2 = await (tx2.wait ? tx2.wait() : provider.waitForTransaction(tx2.hash));
      console.log('✅ closeBatch confirmed in block', rc2.blockNumber);
    } else {
      console.log(`🧪 ABI détectée pour closeBatch: ${pick.abi} (no return)`);
      await sendNoReturn(pick.contract, 'closeBatch', [assetId, reason, idsRaw]);
    }

  } catch (err) {
    console.error('💥 Error:', err?.shortMessage || err?.reason || err?.message || err);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('❌ Fatal:', e?.message || e);
  process.exit(1);
});
