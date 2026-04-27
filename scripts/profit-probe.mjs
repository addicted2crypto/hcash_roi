// scripts/profit-probe.mjs
// Standalone feasibility probe — does NOT modify the app.
// Writes data/profit-probe.json. Re-runs resume from checkpoint.
//
// Usage: node scripts/profit-probe.mjs
// Optional env: AVAX_RPC_URL=<primary>, HC_API_KEY=<required>

import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '..', 'data', 'profit-probe.json');

// ── Config ─────────────────────────────────────────────────────────────
const HC_API      = 'https://api.hashcash.club/api/v1/public';
const HC_API_KEY  = process.env.HC_API_KEY;
const GAME_MAIN   = '0x105fecae0c48d683dA63620De1f2d1582De9e98a';
const MARKETPLACE = '0x511FC8b8e5D07a012D17f56fE8bfdE576c8Dd13d';
const HCASH_TOKEN = '0xba5444409257967e5e50b113c395a766b0678c03';

// RPC pool — ordered by current reliability (publicnode tested fastest today)
const RPC_ENDPOINTS = [
  process.env.AVAX_RPC_URL,
  'https://avalanche-c-chain-rpc.publicnode.com',
  'https://api.avax.network/ext/bc/C/rpc',
  'https://avax.meowrpc.com',
  'https://avalanche.drpc.org',
  'https://endpoints.omniatech.io/v1/avax/mainnet/public',
].filter(Boolean);

const CHUNK_SIZE = 2000; // Avax getLogs cap is 2048; use 2000 for safety
const DEFAULT_AVAX_USD = 9.34; // spot fallback if DexScreener unavailable
let rpcCallCount = 0;

// ── FallbackProvider: standard ethers pattern — tries endpoints in order on failure
// Each JsonRpcProvider is marked with the Avalanche network so ethers doesn't probe.
const AVAX_NETWORK = new ethers.Network('avalanche', 43114n);
const providerList = RPC_ENDPOINTS.map((url, i) => ({
  provider: new ethers.JsonRpcProvider(url, AVAX_NETWORK, { staticNetwork: AVAX_NETWORK }),
  priority: i + 1,
  stallTimeout: 3000,
  weight: 1,
}));
const provider = new ethers.FallbackProvider(providerList, AVAX_NETWORK, { quorum: 1 });

// ── Persistence ────────────────────────────────────────────────────────
function loadCheckpoint() {
  if (!fs.existsSync(DATA_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch { return null; }
}
function saveCheckpoint(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// ── Helpers ────────────────────────────────────────────────────────────
const ABI_CACHE_DIR = path.resolve(__dirname, '..', 'data', 'abi-cache');
async function getAbi(abiId) {
  // 1) local cache
  const cachePath = path.join(ABI_CACHE_DIR, `${abiId}.json`);
  if (fs.existsSync(cachePath)) {
    try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  }
  // 2) fetch with retry
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${HC_API}/abis/${abiId}.json`, {
        headers: { 'x-api-key': HC_API_KEY },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      fs.mkdirSync(ABI_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(json.abi, null, 2));
      return json.abi;
    } catch (err) {
      lastErr = err;
      console.log(`[probe] ABI fetch ${abiId} attempt ${i + 1} failed: ${err.message.slice(0, 80)}, retrying...`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error(`ABI fetch failed after 5 retries: ${abiId} — ${lastErr?.message}`);
}

async function getLiveAvaxUsd() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=hCASH');
    const data = await res.json();
    const p = (data.pairs || []).find(pp =>
      pp.chainId === 'avalanche' && pp.baseToken?.symbol?.toUpperCase() === 'HCASH'
    );
    if (!p) return DEFAULT_AVAX_USD;
    const hcashUsd = parseFloat(p.priceUsd || 0);
    const hcashAvax = parseFloat(p.priceNative || 0);
    return hcashAvax > 0 ? hcashUsd / hcashAvax : DEFAULT_AVAX_USD;
  } catch { return DEFAULT_AVAX_USD; }
}

async function discoverDexPair() {
  const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=hCASH');
  const data = await res.json();
  const p = (data.pairs || [])
    .filter(pp => pp.chainId === 'avalanche' && pp.baseToken?.symbol?.toUpperCase() === 'HCASH')
    .sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))[0];
  if (!p) throw new Error('No hCASH DEX pair found');
  return p.pairAddress.toLowerCase();
}

function uniqueEventNames(abi) {
  return abi.filter(x => x.type === 'event').map(x => x.name);
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  if (!HC_API_KEY) { console.error('Missing HC_API_KEY in .env'); process.exit(1); }
  const started = Date.now();
  const prev = loadCheckpoint() || {};
  const meta = prev.meta || {};
  meta.lastProcessedBlock = meta.lastProcessedBlock || {};

  console.log(`[probe] Starting. RPC pool: ${RPC_ENDPOINTS.length} endpoints`);

  // ── 1. Bootstrap ────────────────────────────────────────────────────
  const [marketplaceAbi, gameAbi] = await Promise.all([
    getAbi('marketplace.v1'),
    getAbi('main.v1'),
  ]);
  const marketplace = new ethers.Contract(MARKETPLACE, marketplaceAbi, provider);
  const game = new ethers.Contract(GAME_MAIN, gameAbi, provider);
  const hcash = new ethers.Contract(HCASH_TOKEN, [
    'event Transfer(address indexed from, address indexed to, uint256 value)'
  ], provider);

  console.log('[probe] Marketplace events:', uniqueEventNames(marketplaceAbi).filter(n => /sale|buy|sold|purchase/i.test(n)).join(', ') || '(none match filter)');
  console.log('[probe] Game events:',        uniqueEventNames(gameAbi).filter(n => /miner|facility|claim|purchase|bought/i.test(n)).join(', ') || '(none match filter)');

  // ── 2. Discover DEX pair + token0/token1 ───────────────────────────
  const pairAddress = meta.dexPair?.address || await discoverDexPair();
  const pair = new ethers.Contract(pairAddress, [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  ], provider);
  const [token0, token1] = meta.dexPair?.token0 && meta.dexPair?.token1
    ? [meta.dexPair.token0, meta.dexPair.token1]
    : await Promise.all([pair.token0(), pair.token1()]);
  const hcashIsToken0 = token0.toLowerCase() === HCASH_TOKEN.toLowerCase();
  const hcashSide = hcashIsToken0 ? 'token0' : 'token1';
  console.log(`[probe] DEX pair ${pairAddress}`);
  console.log(`[probe]   token0 = ${token0}`);
  console.log(`[probe]   token1 = ${token1}`);
  console.log(`[probe]   hCASH is ${hcashSide} (sell direction: amount${hcashIsToken0 ? '0' : '1'}In > 0 && amount${hcashIsToken0 ? '1' : '0'}Out > 0)`);

  meta.dexPair = { address: pairAddress, token0, token1, hcashSide };

  // ── 3. Fetch AVAX/USD spot ──────────────────────────────────────────
  const avaxUsd = await getLiveAvaxUsd();
  console.log(`[probe] AVAX/USD spot: $${avaxUsd.toFixed(4)}`);

  // ── 4. Determine scan range ─────────────────────────────────────────
  const latestBlock = Number(await provider.getBlockNumber());
  // startBlock() from game contract = game epoch start
  const gameStart = Number(await game.startBlock());
  const defaultStart = gameStart;
  console.log(`[probe] Chain latest block: ${latestBlock}, game startBlock: ${gameStart}`);

  // Per-stream checkpoint
  const streams = {
    marketplaceNewSale: meta.lastProcessedBlock.marketplaceNewSale ?? defaultStart,
    gameMainAll:        meta.lastProcessedBlock.gameMainAll        ?? defaultStart,
    hcashTransferToPair:meta.lastProcessedBlock.hcashTransferToPair?? defaultStart,
    dexPairSwap:        meta.lastProcessedBlock.dexPairSwap        ?? defaultStart,
  };

  // ── 5. Per-wallet aggregates ────────────────────────────────────────
  // { [wallet]: { usdOut: number, usdIn: number, notes: {...} } }
  const wallets = new Map();
  const ensure = (addr) => {
    const key = addr.toLowerCase();
    if (!wallets.has(key)) wallets.set(key, { usdOut: 0, usdIn: 0, avaxSpent: 0, hcashSold: 0n, avaxReceivedDex: 0n, marketplaceSales: 0, marketplaceBuys: 0 });
    return wallets.get(key);
  };

  // ── 6. Scan streams ─────────────────────────────────────────────────

  // (a) DEX pair Swap events → per-tx hCASH sold (for join with Transfer)
  const swapByTx = new Map(); // txHash → { a0In, a1Out }
  console.log(`[probe] Scanning DEX pair Swap from ${streams.dexPairSwap} to ${latestBlock}...`);
  let dexFromBlock = streams.dexPairSwap;
  let dexChunks = 0;
  while (dexFromBlock <= latestBlock) {
    const toBlock = Math.min(dexFromBlock + CHUNK_SIZE - 1, latestBlock);
    try {
      const logs = await pair.queryFilter(pair.filters.Swap(), dexFromBlock, toBlock);
      for (const e of logs) {
        const a0In = BigInt(e.args.amount0In);
        const a1In = BigInt(e.args.amount1In);
        const a0Out = BigInt(e.args.amount0Out);
        const a1Out = BigInt(e.args.amount1Out);
        // hCASH SELL: hCASH in → WAVAX out
        const sold = hcashIsToken0 ? (a0In > 0n && a1Out > 0n) : (a1In > 0n && a0Out > 0n);
        if (sold) {
          const hcashAmt = hcashIsToken0 ? a0In : a1In;
          const avaxAmt  = hcashIsToken0 ? a1Out : a0Out;
          const prev = swapByTx.get(e.transactionHash) || { hcashSold: 0n, avaxReceived: 0n };
          prev.hcashSold += hcashAmt;
          prev.avaxReceived += avaxAmt;
          swapByTx.set(e.transactionHash, prev);
        }
      }
    } catch (err) {
      console.log(`[probe] DEX swap chunk error ${dexFromBlock}: ${err.message.slice(0, 80)}`);
    }
    streams.dexPairSwap = toBlock;
    dexFromBlock = toBlock + 1;
    dexChunks++;
    if (dexChunks % 50 === 0) console.log(`[probe]   DEX progress: block ${toBlock}, swaps indexed: ${swapByTx.size}`);
  }
  console.log(`[probe] DEX swaps (sells only) indexed: ${swapByTx.size} txs`);

  // (b) hCASH Transfer events FROM wallet TO pair → attribute sale to wallet
  console.log(`[probe] Scanning hCASH Transfer → pair from ${streams.hcashTransferToPair}...`);
  let trFromBlock = streams.hcashTransferToPair;
  let trChunks = 0;
  let transferMatches = 0;
  while (trFromBlock <= latestBlock) {
    const toBlock = Math.min(trFromBlock + CHUNK_SIZE - 1, latestBlock);
    try {
      const logs = await hcash.queryFilter(
        hcash.filters.Transfer(null, pairAddress),
        trFromBlock, toBlock
      );
      for (const e of logs) {
        const swap = swapByTx.get(e.transactionHash);
        if (!swap) continue; // transfer that wasn't part of a sell swap (LP add, etc.)
        const seller = e.args.from;
        const w = ensure(seller);
        const hcashAmt = BigInt(e.args.value);
        // If multiple transfers per swap-tx (rare), divide avax proportionally
        const share = swap.hcashSold > 0n ? Number((hcashAmt * 10_000n) / swap.hcashSold) / 10_000 : 1;
        const avaxShare = Number(swap.avaxReceived) / 1e18 * share;
        w.hcashSold += hcashAmt;
        w.avaxReceivedDex += BigInt(Math.round(avaxShare * 1e18));
        w.usdOut += avaxShare * avaxUsd;
        transferMatches++;
      }
    } catch (err) {
      console.log(`[probe] Transfer chunk error ${trFromBlock}: ${err.message.slice(0, 80)}`);
    }
    streams.hcashTransferToPair = toBlock;
    trFromBlock = toBlock + 1;
    trChunks++;
    if (trChunks % 50 === 0) console.log(`[probe]   Transfer progress: block ${toBlock}, sellers matched: ${transferMatches}`);
  }
  console.log(`[probe] hCASH→pair transfers matched to swaps: ${transferMatches}`);

  // (c) Game main events: InitialFacilityPurchased (2 AVAX) + MinerBoughtWithAvax (variable AVAX)
  console.log(`[probe] Scanning game events...`);
  let gFromBlock = streams.gameMainAll;
  let gChunks = 0;
  let entries = 0, minerAvaxBuys = 0;
  const STARTER_AVAX = 2;
  while (gFromBlock <= latestBlock) {
    const toBlock = Math.min(gFromBlock + CHUNK_SIZE - 1, latestBlock);
    try {
      const [ifp, mba] = await Promise.all([
        game.queryFilter(game.filters.InitialFacilityPurchased?.() || [], gFromBlock, toBlock).catch(() => []),
        game.queryFilter(game.filters.MinerBoughtWithAvax?.() || [], gFromBlock, toBlock).catch(() => []),
      ]);
      for (const e of ifp) {
        const addr = e.args?.player || e.args?.[0];
        if (!addr) continue;
        const w = ensure(addr);
        w.avaxSpent += STARTER_AVAX;
        w.usdIn += STARTER_AVAX * avaxUsd;
        entries++;
      }
      for (const e of mba) {
        const addr = e.args?.player || e.args?.[0];
        const priceArg = e.args?.price ?? e.args?.[2] ?? e.args?.[1];
        if (!addr || priceArg === undefined) continue;
        const avaxPaid = Number(BigInt(priceArg)) / 1e18;
        const w = ensure(addr);
        w.avaxSpent += avaxPaid;
        w.usdIn += avaxPaid * avaxUsd;
        minerAvaxBuys++;
      }
    } catch (err) {
      console.log(`[probe] Game chunk error ${gFromBlock}: ${err.message.slice(0, 80)}`);
    }
    streams.gameMainAll = toBlock;
    gFromBlock = toBlock + 1;
    gChunks++;
    if (gChunks % 50 === 0) console.log(`[probe]   Game progress: block ${toBlock}, entries=${entries}, avaxBuys=${minerAvaxBuys}`);
  }
  console.log(`[probe] Game: ${entries} starter entries × 2 AVAX + ${minerAvaxBuys} miner AVAX buys`);

  // (d) Marketplace NewSale — find correct event name from ABI
  const saleEventName = uniqueEventNames(marketplaceAbi).find(n => /newsale/i.test(n)) || 'NewSale';
  console.log(`[probe] Scanning marketplace ${saleEventName} from ${streams.marketplaceNewSale}...`);
  // USDC address on AVAX C-Chain
  const USDC_C = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'.toLowerCase();
  const WAVAX_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'.toLowerCase();
  const NULL_CURRENCY = '0x0000000000000000000000000000000000000000';
  let mFromBlock = streams.marketplaceNewSale;
  let mChunks = 0;
  let saleCount = 0;
  while (mFromBlock <= latestBlock) {
    const toBlock = Math.min(mFromBlock + CHUNK_SIZE - 1, latestBlock);
    try {
      const filter = marketplace.filters[saleEventName]?.() || null;
      if (!filter) break;
      const logs = await marketplace.queryFilter(filter, mFromBlock, toBlock);
      for (const e of logs) {
        // Common NewSale fields: listingCreator, buyer, currency, totalPricePaid
        const seller = e.args?.listingCreator || e.args?.seller;
        const buyer  = e.args?.buyer;
        const currency = (e.args?.currency || '').toLowerCase();
        const priceWei = BigInt(e.args?.totalPricePaid ?? e.args?.pricePaid ?? 0);
        if (!seller || !buyer || priceWei === 0n) continue;

        let usdAmount = 0;
        if (currency === USDC_C) usdAmount = Number(priceWei) / 1e6;
        else if (currency === WAVAX_NATIVE || currency === NULL_CURRENCY) usdAmount = (Number(priceWei) / 1e18) * avaxUsd;
        else if (currency === HCASH_TOKEN) { /* skip: sold for hCASH, not a realized USD exit */ saleCount++; continue; }
        else continue; // unknown currency

        const wSeller = ensure(seller);
        const wBuyer  = ensure(buyer);
        wSeller.usdOut += usdAmount;
        wSeller.marketplaceSales++;
        wBuyer.usdIn   += usdAmount;
        wBuyer.marketplaceBuys++;
        saleCount++;
      }
    } catch (err) {
      console.log(`[probe] Marketplace chunk error ${mFromBlock}: ${err.message.slice(0, 80)}`);
    }
    streams.marketplaceNewSale = toBlock;
    mFromBlock = toBlock + 1;
    mChunks++;
    if (mChunks % 50 === 0) console.log(`[probe]   Marketplace progress: block ${toBlock}, sales counted: ${saleCount}`);
  }
  console.log(`[probe] Marketplace sales processed: ${saleCount}`);

  // ── 7. Compute final stats ──────────────────────────────────────────
  const entries2 = [...wallets.entries()].map(([wallet, v]) => ({
    wallet,
    usdIn: +v.usdIn.toFixed(2),
    usdOut: +v.usdOut.toFixed(2),
    netUsd: +(v.usdOut - v.usdIn).toFixed(2),
    avaxSpent: +v.avaxSpent.toFixed(4),
    hcashSold: (Number(v.hcashSold) / 1e18).toFixed(2),
    marketplaceSales: v.marketplaceSales,
    marketplaceBuys: v.marketplaceBuys,
  }));
  const withOutflow = entries2.filter(e => e.usdIn > 0);
  const inProfit = withOutflow.filter(e => e.netUsd > 0);
  const top20 = [...entries2].sort((a, b) => b.netUsd - a.netUsd).slice(0, 20);
  const bottom20 = [...entries2].sort((a, b) => a.netUsd - b.netUsd).slice(0, 20);

  const netSorted = withOutflow.map(e => e.netUsd).sort((a, b) => a - b);
  const medianRealizedUsd = netSorted.length ? netSorted[Math.floor(netSorted.length / 2)] : 0;

  const result = {
    meta: {
      ...meta,
      lastProcessedBlock: streams,
      tokenMetadata: {
        hcash: { symbol: 'HCASH', decimals: 18 },
        wavax: { symbol: 'WAVAX', decimals: 18 },
        usdc:  { symbol: 'USDC',  decimals: 6  },
      },
    },
    scanRange: { fromBlock: gameStart, toBlock: latestBlock, spanBlocks: latestBlock - gameStart },
    avaxUsdSpot: avaxUsd,
    totalWalletsSeen: wallets.size,
    walletsWithAnyOutflow: withOutflow.length,
    walletsInProfit: inProfit.length,
    medianRealizedUsd,
    top20,
    bottom20,
    scanDurationSec: Math.round((Date.now() - started) / 1000),
    rpcCallCount,
    updatedAt: new Date().toISOString(),
  };

  saveCheckpoint(result);

  // ── 8. Summary ──────────────────────────────────────────────────────
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`Wallets seen: ${result.totalWalletsSeen}`);
  console.log(`Wallets with any USD outflow (actual players): ${result.walletsWithAnyOutflow}`);
  console.log(`Wallets in profit (USD out > USD in): ${result.walletsInProfit}`);
  console.log(`Median realized USD: $${result.medianRealizedUsd.toFixed(2)}`);
  console.log(`Scan duration: ${result.scanDurationSec}s, RPC calls: ${rpcCallCount}`);
  console.log('════════════════════════════════════════════════════════════════');
  console.log('Top 5 profitable wallets:');
  top20.slice(0, 5).forEach(w => console.log(`  ${w.wallet.slice(0,10)}... · in=$${w.usdIn.toFixed(0)} · out=$${w.usdOut.toFixed(0)} · net=$${w.netUsd.toFixed(0)}`));
  console.log('Bottom 5 underwater:');
  bottom20.slice(0, 5).forEach(w => console.log(`  ${w.wallet.slice(0,10)}... · in=$${w.usdIn.toFixed(0)} · out=$${w.usdOut.toFixed(0)} · net=$${w.netUsd.toFixed(0)}`));
  console.log('');
  console.log(`Data written to: ${DATA_PATH}`);
}

main().catch(err => {
  console.error('[probe] FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
