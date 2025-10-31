// executor.js
// Usage examples:
//  node executor.js limit "[123,329]" 0xYOUR_PRIVATE_KEY --addr=0x... --asset=0
//  node executor.js tp "1,2,3" --pk=0xYOUR_PRIVATE_KEY --addr=0x... --rpc=... --asset=0

import 'dotenv/config';
import { ethers } from 'ethers';

/* =========================
   CONFIG
========================= */
const DEFAULT_RPC = process.env.RPC_URL || 'https://atlantic.dplabs-internal.com';
const DEFAULT_ADDR = process.env.EXECUTOR_ADDR; // optional fallback from .env

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

/** parse a possible positional private key (third arg) */
function extractPositionalPk(argv) {
  // argv here is process.argv.slice(2)
  // argv[0] = mode, argv[1] = idsArg, argv[2] MAY be PK (if not a flag)
  if (argv.length >= 3) {
    const candidate = argv[2];
    if (!candidate.startsWith('--')) {
      return candidate;
    }
  }
  return null;
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
  try { return !!ethersMod?.Contract && !!ethersMod?.isAddress; } catch { return false; }
}

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
  // fallback: low-level call
  const iface = contract.interface;
  const data = iface.encodeFunctionData(fn, args);
  const runner = contract.runner || contract.provider;
  if (!runner || !runner.call) throw new Error('No runner/provider.call available for manual call fallback');
  const call = await runner.call({ to: contract.target || contract.address, data });
  const decoded = iface.decodeFunctionResult(fn, call);
  return Array.from(decoded ?? []);
}

/* Essaye d'abord ABI32, sinon ABI256 */
async function withAnyAbi(provider, walletOrProvider, address, fnName, args) {
  const c32 = new ethers.Contract(address, ABI32, provider);
  try {
    const out = await simulateOrStatic(c32, fnName, args);
    return { which: 'uint32[]', contract: new ethers.Contract(address, ABI32, walletOrProvider), sim: out };
  } catch (e1) {
    const c256 = new ethers.Contract(address, ABI256, provider);
    const out = await simulateOrStatic(c256, fnName, args);
    return { which: 'uint256[]', contract: new ethers.Contract(address, ABI256, walletOrProvider), sim: out };
  }
}

/* =========================
   MAIN
========================= */
async function main() {
  const argvAll = process.argv.slice(2);
  const mode = (argvAll[0] || '').toLowerCase(); // "limit" | "sl" | "tp" | "liq"
  const idsArg = argvAll[1];
  const positionalPk = extractPositionalPk(argvAll);
  const flags = parseFlags(argvAll.slice(2)); // flags after argv[2] if any

  if (!['limit', 'sl', 'tp', 'liq'].includes(mode)) {
    console.error('Usage:');
    console.error('  node executor.js limit "[123,329]" 0xPK --addr=0x... [--asset=0] [--rpc=...]');
    console.error('  node executor.js tp "1,2,3" --pk=0xPK --addr=0x... ');
    process.exit(1);
  }

  const idsRaw = parseIds(idsArg);
  const assetId = flags.asset !== undefined ? Number(flags.asset) : (Number(process.env.ASSET_ID) || 0);
  if (!Number.isInteger(assetId) || assetId < 0) throw new Error('Paramètre --asset invalide');

  const RPC_URL = flags.rpc || DEFAULT_RPC;
  const EXECUTOR_ADDR = flags.addr || DEFAULT_ADDR;
  if (!EXECUTOR_ADDR) throw new Error('Adresse du contrat manquante. --addr=0x... ou EXECUTOR_ADDR dans .env');

  // prioritize: positionalPk > --pk flag > env PRIVATE_KEY
  const PRIVATE_KEY = positionalPk || flags.pk || process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) {
    console.error('Erreur: Aucune clé privée fournie. Passe la clé en positionnel ou via --pk=... ou via env PRIVATE_KEY');
    console.error('Ex: node executor.js limit "[1]" 0xYOUR_PRIVATE_KEY --addr=0x...');
    console.error('⚠️ Attention: passer une clé en clair via l\'historique shell peut être visible — préfère fichier ou variable d\'env si possible.');
    process.exit(1);
  }

  // basic validation of pk (0x + 64 hex) or 64 hex
  const pkCandidate = String(PRIVATE_KEY).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pkCandidate) && !/^[0-9a-fA-F]{64}$/.test(pkCandidate)) {
    console.warn('⚠️ Forme étrange pour la clé privée. Elle devrait ressembler à 0x' + '...64 hex...');
  }

  const provider = new (ethers.JsonRpcProvider ? ethers.JsonRpcProvider : ethers.providers.JsonRpcProvider)(RPC_URL);
  const wallet = new ethers.Wallet(pkCandidate.startsWith('0x') ? pkCandidate : `0x${pkCandidate}`, provider);

  console.log('🔗 RPC:', RPC_URL);
  console.log('👤 Wallet:', wallet.address);
  console.log('⚙️  Contract:', EXECUTOR_ADDR);
  console.log('📦 Mode:', mode, '| Asset:', assetId, '| IDs:', idsRaw.join(','));
  console.log('🧭 Ethers version:', (ethers.version || 'unknown'));

  try {
    if (mode === 'limit') {
      // Test ABI + simulate
      const { which, contract, sim } = await withAnyAbi(provider, provider, EXECUTOR_ADDR, 'execLimits', [assetId, idsRaw]);
      const [executedSim = 0, skippedSim = 0] = sim;
      console.log(`🧪 ABI détectée pour execLimits: ${which}`);
      console.log(`🧠 simulate.execLimits → executed=${executedSim} | skipped=${skippedSim}`);

      // Envoi réel (contract connecté au wallet)
      const cw = new ethers.Contract(EXECUTOR_ADDR, (which === 'uint32[]' ? ABI32 : ABI256), wallet);
      const tx = await cw.execLimits(assetId, idsRaw);
      console.log('🚀 execLimits tx:', tx.hash || tx);
      const rc = await (tx.wait ? tx.wait() : provider.waitForTransaction(tx.hash));
      console.log('✅ execLimits confirmed in block', rc.blockNumber);
      return;
    }

    // sl/tp/liq via closeBatch(reason)
    const reason = reasonFromMode(mode);
    if (!reason) throw new Error('Reason inconnu');

    const { which, contract, sim } = await withAnyAbi(provider, provider, EXECUTOR_ADDR, 'closeBatch', [assetId, reason, idsRaw]);
    const [closedSim = 0, skippedSim = 0] = sim;
    console.log(`🧪 ABI détectée pour closeBatch: ${which}`);
    console.log(`🧠 simulate.closeBatch(${reason}) → closed=${closedSim} | skipped=${skippedSim}`);

    const cw2 = new ethers.Contract(EXECUTOR_ADDR, (which === 'uint32[]' ? ABI32 : ABI256), wallet);
    const tx2 = await cw2.closeBatch(assetId, reason, idsRaw);
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
