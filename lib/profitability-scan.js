// Profitability scan: discovers all hCASH players, computes Metric A (operational
// per-facility profit) and Metric B (per-wallet realized + paper P&L), writes
// JSON snapshots that drive /profitability and /wallet/[address] routes.
//
// Accuracy commitments:
//  - All numbers are reads against the canonical contracts; no API tagging
//  - Snapshot consistency: latestBlock captured ONCE at scan start, used everywhere
//  - Periodic checkpoint saves: a kill doesn't lose progress
//  - Self-validating: writes a `_validation` block with sanity sums
//  - Per-wallet `_proof` field with raw inputs so any number is auditable
//
// Two outputs:
//  - data/profitability-cohorts.json  → /profitability page (global + facility tables)
//  - data/wallet-pnl.json             → /wallet/[address] route (per-wallet records)

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { withFailover, RPC_ENDPOINTS } from "./rpc-failover.js";

// ─── Constants ────────────────────────────────────────────────────────────
export const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
export const MARKETPLACE = "0x511FC8b8e5D07a012D17f56fE8bfdE576c8Dd13d";
export const HCASH_TOKEN = "0xba5444409257967e5e50b113c395a766b0678c03";
export const PHARAOH_PAIR = "0x8F961980518BC9ab302948De7948580666dc35D9";
const NATIVE_AVAX = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO_ADDR   = "0x0000000000000000000000000000000000000000";
const USDC_C      = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e";

// Avalanche getLogs cap is 2048; 2000 is the safe chunk
const CHUNK = 2000;

// ─── Helpers ──────────────────────────────────────────────────────────────
function lcAddr(a) { return (a || "").toLowerCase(); }

async function loadAbi(abiId) {
  // Prefer the local ABI cache (these don't change often)
  const cachePath = path.resolve("data/abi-cache", `${abiId}.json`);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }
  // Fallback: fetch from hashcash public API
  const res = await fetch(`https://api.hashcash.club/api/v1/public/abis/${abiId}.json`, {
    headers: { "x-api-key": process.env.HC_API_KEY || "" },
  });
  if (!res.ok) throw new Error(`ABI fetch failed for ${abiId}: ${res.status}`);
  const json = await res.json();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(json.abi, null, 2));
  return json.abi;
}

async function getAvaxUsd(provider) {
  // Chainlink AVAX/USD aggregator on Avalanche C-Chain
  const CL = "0x0A77230d17318075983913bC2145DB16C7366156";
  const SEL = "0xfeaf968c"; // latestRoundData()
  try {
    const res = await provider.call({ to: CL, data: SEL });
    if (!res || res.length < 130) return null;
    const v = parseInt(res.slice(66, 130), 16);
    return v > 0 && v < 1e13 ? v / 1e8 : null;
  } catch { return null; }
}

async function getHcashAvaxSpot() {
  // DexScreener — public, no key. Gives us the live AVAX/hCASH ratio.
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=hCASH",
      { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    const p = (d.pairs || []).find(pp =>
      pp.chainId === "avalanche" && pp.baseToken?.symbol?.toUpperCase() === "HCASH"
    );
    if (!p) return null;
    return parseFloat(p.priceNative); // hCASH price in WAVAX
  } catch { return null; }
}

// Run a logs query through failover with retries on chunk boundaries
async function getLogsFailover(filter, fromBlock, toBlock, label) {
  return withFailover(async (provider) => {
    return provider.getLogs({
      ...filter,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    });
  }, { label, timeoutMs: 8000 });
}

function topicForEvent(iface, name) {
  return iface.getEvent(name).topicHash;
}

// ─── Persistence ──────────────────────────────────────────────────────────
const CHECKPOINT_PATH = path.resolve("data/scan-checkpoint.json");
const COHORTS_PATH    = path.resolve("data/profitability-cohorts.json");
const WALLETS_PATH    = path.resolve("data/wallet-pnl.json");

export function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8")); } catch { return null; }
}

function saveCheckpoint(state) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(state, null, 2));
}

function saveOutputs(cohorts, wallets) {
  fs.mkdirSync(path.dirname(COHORTS_PATH), { recursive: true });
  fs.writeFileSync(COHORTS_PATH, JSON.stringify(cohorts, null, 2));
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2));
}

// ─── Main scan ────────────────────────────────────────────────────────────
export async function runScan({
  fromBlock = null,        // null = resume from checkpoint or start at gameStart
  toBlock = null,          // null = current chain head
  onProgress = () => {},
  saveEvery = 5,           // save outputs every N chunks
} = {}) {
  const startedAt = Date.now();
  const checkpoint = loadCheckpoint() || {};

  // Load ABIs
  const [gameAbi, marketAbi] = await Promise.all([
    loadAbi("main.v1"),
    loadAbi("marketplace.v1"),
  ]);
  const gameIface   = new ethers.Interface(gameAbi);
  const marketIface = new ethers.Interface(marketAbi);

  // Bootstrap chain reads in one failover round
  // Includes the network-wide aggregates needed for concentration leaderboards
  // (hCASH totalSupply for token-holder %, totalHashrate for network mining %).
  const boot = await withFailover(async (provider) => {
    const game = new ethers.Contract(GAME_MAIN, gameAbi, provider);
    const hcash = new ethers.Contract(HCASH_TOKEN, [
      "function totalSupply() view returns (uint256)"
    ], provider);
    const [latest, gameStart, initialPrice, totalHashrate, totalSupply] = await Promise.all([
      provider.getBlockNumber(),
      game.startBlock(),
      game.initialFacilityPrice(),
      game.totalHashrate(),
      hcash.totalSupply(),
    ]);
    return {
      latest: Number(latest),
      gameStart: Number(gameStart),
      initialPriceWei: BigInt(initialPrice),
      totalHashrate: Number(totalHashrate),
      hcashTotalSupplyWei: BigInt(totalSupply),
    };
  }, { label: "boot" });

  const scanFrom = fromBlock ?? checkpoint.lastProcessedBlock ?? boot.gameStart;
  const scanTo   = toBlock   ?? boot.latest;
  const initialEntryAvax = Number(boot.initialPriceWei) / 1e18;

  onProgress({ phase: "boot", scanFrom, scanTo, gameStart: boot.gameStart, initialEntryAvax });

  // Spot rates for USD-denomination of cohort tagging
  const avaxUsd = await withFailover(getAvaxUsd, { label: "avaxUsd" });
  const hcashAvaxSpot = await getHcashAvaxSpot();
  if (avaxUsd === null) throw new Error("Chainlink AVAX/USD read failed across all RPCs");
  if (hcashAvaxSpot === null) throw new Error("DexScreener hCASH/AVAX spot read failed");

  // ─── Per-wallet aggregate accumulator ───
  // Keyed by lowercased address. Bigints kept in wei for exactness; converted on output.
  const wallets = new Map();
  // Pre-load any prior state so we can do incremental scans.
  // All wei-suffixed fields are bigints serialized as strings; rehydrate them.
  if (checkpoint.wallets && scanFrom > boot.gameStart) {
    for (const [k, v] of Object.entries(checkpoint.wallets)) {
      const rehydrated = { ...v };
      for (const [field, val] of Object.entries(v)) {
        if (field.endsWith("Wei") && typeof val === "string") {
          rehydrated[field] = BigInt(val || "0");
        }
      }
      wallets.set(k, rehydrated);
    }
  }
  function ensure(addr) {
    const k = lcAddr(addr);
    if (!wallets.has(k)) {
      wallets.set(k, {
        entries: 0,
        minerAvaxBuys: 0,           // MinerBoughtWithAvax events
        minerHcashBuys: 0,          // MinerBought (hCASH) events — game-internal hCASH spend
        facilityUpgrades: 0,        // FacilityBought events
        marketBuys: 0,
        marketSells: 0,
        dexSells: 0,
        dexBuys: 0,                 // AVAX→hCASH swaps (cost basis if they accumulated)
        avaxInWei: 0n,              // AVAX flowed OUT of their wallet (cost basis): entry + miner AVAX buys + market AVAX/USDC buys + DEX hCASH purchases
        avaxOutWei: 0n,             // AVAX flowed INTO their wallet (proceeds): DEX hCASH sells + market AVAX/USDC sells
        hcashSoldWei: 0n,
        hcashBoughtWei: 0n,
        hcashSpentInGameWei: 0n,    // hCASH burned: facility upgrades + MinerBought (non-AVAX) — record but do NOT add to avaxIn (would double-count w/ DEX buys)
      });
    }
    return wallets.get(k);
  }

  // ─── Pharaoh pair token0/token1 ───
  const pairTokens = await withFailover(async (provider) => {
    const pair = new ethers.Contract(PHARAOH_PAIR, [
      "function token0() view returns (address)",
      "function token1() view returns (address)",
    ], provider);
    const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
    return { token0: lcAddr(t0), token1: lcAddr(t1) };
  }, { label: "pairTokens" });
  const hcashIsToken0 = pairTokens.token0 === HCASH_TOKEN.toLowerCase();

  // ─── Chunked event scan ───
  // Per chunk, we fire 3 grouped log queries through failover (game / marketplace / dex).
  // After all chunks complete, we resolve DEX swap attribution by fetching tx.from for
  // each unique swap tx hash — this catches Magpie / 1inch / Paraswap / Odos / etc. routers
  // that show up as the immediate Transfer source but aren't the actual seller.
  const ifpTopic   = topicForEvent(gameIface, "InitialFacilityPurchased");
  const mbaTopic   = topicForEvent(gameIface, "MinerBoughtWithAvax");
  const mbTopic    = topicForEvent(gameIface, "MinerBought");        // hCASH-paid miner buys
  const fbTopic    = topicForEvent(gameIface, "FacilityBought");     // hCASH-paid facility upgrades
  const newListingTopic     = topicForEvent(marketIface, "NewListing");
  const updatedListingTopic = topicForEvent(marketIface, "UpdatedListing");
  const newSaleTopic        = topicForEvent(marketIface, "NewSale");
  const swapTopic = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");

  // listingId → currency map, populated as we scan NewListing/UpdatedListing
  // The currency is in the listing tuple's `currency` field. We need it to interpret NewSale.
  const listingCurrency = new Map();

  // Collected DEX swap data — attribution happens after the chunk loop
  // Each entry: { txHash, blockNumber, hcashIn, hcashOut, avaxIn, avaxOut } (token0/1 mapped)
  // hcashIn>0 = sell (player sent hCASH); hcashOut>0 = buy (player received hCASH)
  const swapsByTx = new Map();

  const chunks = Math.ceil((scanTo - scanFrom + 1) / CHUNK);
  let processedChunks = 0;
  let totalEvents = 0;

  for (let from = scanFrom; from <= scanTo; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, scanTo);

    // ─── 1. Game events (4 event types) ───
    try {
      const gameLogs = await getLogsFailover(
        { address: GAME_MAIN, topics: [[ifpTopic, mbaTopic, mbTopic, fbTopic]] },
        from, to, `game[${from}-${to}]`
      );
      for (const log of gameLogs) {
        const t0 = log.topics[0];
        const player = ethers.getAddress("0x" + log.topics[1].slice(26));
        const w = ensure(player);
        if (t0 === ifpTopic) {
          w.entries++;
          w.avaxInWei += boot.initialPriceWei;
          totalEvents++;
        } else if (t0 === mbaTopic) {
          // MinerBoughtWithAvax: cost (AVAX wei) is data[0..32]
          const costWei = BigInt("0x" + log.data.slice(2, 66));
          w.minerAvaxBuys++;
          w.avaxInWei += costWei;
          totalEvents++;
        } else if (t0 === mbTopic) {
          // MinerBought (hCASH-paid): same shape — cost in hCASH wei is data[0..32]
          const costWei = BigInt("0x" + log.data.slice(2, 66));
          w.minerHcashBuys++;
          w.hcashSpentInGameWei += costWei;
          totalEvents++;
        } else if (t0 === fbTopic) {
          // FacilityBought: cost (hCASH wei) at data[0..32]
          const costWei = BigInt("0x" + log.data.slice(2, 66));
          w.facilityUpgrades++;
          w.hcashSpentInGameWei += costWei;
          totalEvents++;
        }
      }
    } catch (err) {
      onProgress({ phase: "chunk-skip", source: "game", from, to, err: String(err).slice(0, 100) });
    }

    // ─── 2. Marketplace events ───
    // (a) NewListing + UpdatedListing → build listingId → currency map
    // (b) NewSale → look up currency from map, attribute AVAX/USDC flows
    try {
      const mLogs = await getLogsFailover(
        { address: MARKETPLACE, topics: [[newListingTopic, updatedListingTopic, newSaleTopic]] },
        from, to, `mkt[${from}-${to}]`
      );
      for (const log of mLogs) {
        let parsed;
        try { parsed = marketIface.parseLog(log); } catch { continue; }
        const t0 = log.topics[0];

        if (t0 === newListingTopic || t0 === updatedListingTopic) {
          // listingId is indexed param[1]; tuple `listing` contains the currency
          const listingId = String(parsed.args.listingId);
          const listing = parsed.args.listing;
          if (listing && listing.currency) {
            listingCurrency.set(listingId, lcAddr(listing.currency));
          }
        } else if (t0 === newSaleTopic) {
          const seller = lcAddr(parsed.args.listingCreator);
          const buyer = lcAddr(parsed.args.buyer);
          const listingId = String(parsed.args.listingId);
          const priceWei = BigInt(parsed.args.totalPricePaid);
          if (!seller || !buyer || priceWei === 0n) continue;

          const currency = listingCurrency.get(listingId);
          if (!currency) {
            // Listing wasn't seen in our scan window — skip this sale rather than guess.
            // The full historical scan starts at gameStart so this should be rare.
            continue;
          }

          let avaxEqWei;
          if (currency === NATIVE_AVAX || currency === ZERO_ADDR) {
            avaxEqWei = priceWei;
          } else if (currency === USDC_C) {
            const usd = Number(priceWei) / 1e6;
            avaxEqWei = BigInt(Math.round((usd / avaxUsd) * 1e18));
          } else {
            // hCASH-denominated NFT sale — both sides exchanged hCASH. We track the
            // hCASH spend on the buyer side as in-game hCASH burn (not AVAX flow).
            ensure(buyer).hcashSpentInGameWei += priceWei;
            ensure(buyer).marketBuys++;
            ensure(seller).marketSells++;
            totalEvents++;
            continue;
          }

          ensure(seller).avaxOutWei += avaxEqWei;
          ensure(seller).marketSells++;
          ensure(buyer).avaxInWei += avaxEqWei;
          ensure(buyer).marketBuys++;
          totalEvents++;
        }
      }
    } catch (err) {
      onProgress({ phase: "chunk-skip", source: "market", from, to, err: String(err).slice(0, 100) });
    }

    // ─── 3. DEX swaps (BOTH directions) ───
    // Just collect swap events here; attribution to actual EOA seller/buyer happens
    // in the post-chunk resolution phase (so we can fetch tx.from once per unique tx).
    try {
      const swapLogs = await getLogsFailover(
        { address: PHARAOH_PAIR, topics: [swapTopic] },
        from, to, `swap[${from}-${to}]`
      );
      for (const log of swapLogs) {
        const data = log.data.slice(2);
        const a0In  = BigInt("0x" + data.slice(0,   64));
        const a1In  = BigInt("0x" + data.slice(64,  128));
        const a0Out = BigInt("0x" + data.slice(128, 192));
        const a1Out = BigInt("0x" + data.slice(192, 256));

        const hcashIn  = hcashIsToken0 ? a0In  : a1In;     // player→pool: SELL
        const hcashOut = hcashIsToken0 ? a0Out : a1Out;    // pool→player: BUY
        const avaxIn   = hcashIsToken0 ? a1In  : a0In;     // player→pool: BUY (paid AVAX)
        const avaxOut  = hcashIsToken0 ? a1Out : a0Out;    // pool→player: SELL (received AVAX)

        const isSell = hcashIn > 0n && avaxOut > 0n;
        const isBuy  = hcashOut > 0n && avaxIn > 0n;
        if (!isSell && !isBuy) continue;

        const acc = swapsByTx.get(log.transactionHash) || {
          blockNumber: log.blockNumber, hcashSold: 0n, avaxReceived: 0n, hcashBought: 0n, avaxSpent: 0n,
        };
        if (isSell) { acc.hcashSold   += hcashIn;  acc.avaxReceived += avaxOut; }
        if (isBuy)  { acc.hcashBought += hcashOut; acc.avaxSpent    += avaxIn; }
        swapsByTx.set(log.transactionHash, acc);
      }
    } catch (err) {
      onProgress({ phase: "chunk-skip", source: "dex", from, to, err: String(err).slice(0, 100) });
    }

    processedChunks++;
    if (processedChunks % saveEvery === 0) {
      // Periodic checkpoint — convert ALL bigint fields to strings safely
      const serializedWallets = {};
      for (const [k, v] of wallets) {
        const out = {};
        for (const [field, val] of Object.entries(v)) {
          out[field] = typeof val === "bigint" ? val.toString() : val;
        }
        serializedWallets[k] = out;
      }
      saveCheckpoint({
        lastProcessedBlock: to,
        scanRange: { from: scanFrom, to: scanTo },
        wallets: serializedWallets,
        meta: { totalEvents, processedChunks, lastSavedAt: new Date().toISOString() },
      });
      onProgress({
        phase: "checkpoint", from, to, processedChunks, totalChunks: chunks,
        wallets: wallets.size, events: totalEvents,
      });
    }
  }

  // ─── Resolve DEX swap attribution via tx.from ───
  // For each unique swap tx, fetch tx.from (the EOA that signed the tx) and attribute
  // the sell/buy to that address. This catches Magpie / 1inch / Paraswap / Odos / etc.
  // routers — they appear as the immediate caller (Swap.sender) but the actual seller
  // is the EOA that initiated the transaction.
  const swapTxList = [...swapsByTx.keys()];
  onProgress({ phase: "swap-resolve-begin", uniqueSwapTxs: swapTxList.length });

  const TX_BATCH = 12;
  let swapsResolved = 0;
  for (let i = 0; i < swapTxList.length; i += TX_BATCH) {
    const slice = swapTxList.slice(i, i + TX_BATCH);
    try {
      const fromAddrs = await withFailover(async (provider) => {
        return Promise.all(slice.map(async (txHash) => {
          try {
            const tx = await provider.getTransaction(txHash);
            return { txHash, from: tx ? lcAddr(tx.from) : null };
          } catch { return { txHash, from: null }; }
        }));
      }, { label: `txfrom[${i}]`, timeoutMs: 8000 });

      for (const r of fromAddrs) {
        if (!r.from) continue;
        const sw = swapsByTx.get(r.txHash);
        if (!sw) continue;
        const w = ensure(r.from);
        if (sw.hcashSold > 0n) {
          w.dexSells++;
          w.hcashSoldWei += sw.hcashSold;
          w.avaxOutWei += sw.avaxReceived;
        }
        if (sw.hcashBought > 0n) {
          w.dexBuys++;
          w.hcashBoughtWei += sw.hcashBought;
          w.avaxInWei += sw.avaxSpent;
        }
        swapsResolved++;
      }
    } catch (err) {
      onProgress({ phase: "swap-resolve-skip", at: i, err: String(err).slice(0, 100) });
    }
    if ((i / TX_BATCH) % 20 === 0) {
      onProgress({ phase: "swap-resolve-progress", done: i + slice.length, total: swapTxList.length });
    }
  }
  onProgress({ phase: "swap-resolve-complete", resolved: swapsResolved, totalUniqueTxs: swapTxList.length });

  // ─── Per-wallet contract reads (Metric A + paper hCASH) ───
  // For each discovered wallet, fetch in batches:
  //   playerBigcoinPerBlock(addr), ownerToFacility(addr), balanceOf(hCASH, addr), playerHashrate(addr)
  // Snapshot at scanTo for consistency.
  const addrs = [...wallets.keys()];
  onProgress({ phase: "reads-begin", wallets: addrs.length });

  const READ_BATCH = 12;
  const blocksPerDay = 83802; // current AVAX cadence; close enough for daily-rate display

  for (let i = 0; i < addrs.length; i += READ_BATCH) {
    const slice = addrs.slice(i, i + READ_BATCH);
    try {
      const reads = await withFailover(async (provider) => {
        const game = new ethers.Contract(GAME_MAIN, gameAbi, provider);
        const hcash = new ethers.Contract(HCASH_TOKEN, [
          "function balanceOf(address) view returns (uint256)"
        ], provider);
        return Promise.all(slice.map(async (a) => {
          try {
            const [pbpb, otf, bal, hr] = await Promise.all([
              game.playerBigcoinPerBlock(a),
              game.ownerToFacility(a),
              hcash.balanceOf(a),
              game.playerHashrate(a),
            ]);
            return { addr: a, pbpb: BigInt(pbpb), otf, bal: BigInt(bal), hr: Number(hr) };
          } catch (err) {
            return { addr: a, error: String(err).slice(0, 80) };
          }
        }));
      }, { label: `reads[${i}]`, timeoutMs: 8000 });

      for (const r of reads) {
        const w = wallets.get(r.addr);
        if (!w) continue;
        if (r.error) { w.readError = r.error; continue; }
        const dailyEmissionHcash = (Number(r.pbpb) / 1e18) * blocksPerDay;
        const facIdx = Number(r.otf.facilityIndex);
        const currPower = Number(r.otf.currPowerOutput);
        const elecCostPerBlock = Number(r.otf.electricityCost) / 1e18; // hCASH per power unit per block
        const dailyElecHcash = currPower * elecCostPerBlock * blocksPerDay;
        const netHcashDay = dailyEmissionHcash - dailyElecHcash;
        w.metricA = {
          facilityIndex: facIdx,
          currPower,
          hashrate: r.hr,
          dailyEmissionHcash: +dailyEmissionHcash.toFixed(4),
          dailyElecHcash: +dailyElecHcash.toFixed(4),
          netHcashDay: +netHcashDay.toFixed(4),
          status: netHcashDay > 0.01 ? "profitable" : netHcashDay < -0.01 ? "underwater" : "breakeven",
        };
        w.hcashBalanceWei = r.bal.toString();
      }
    } catch (err) {
      onProgress({ phase: "reads-skip", at: i, err: String(err).slice(0, 100) });
    }
    if ((i / READ_BATCH) % 5 === 0) {
      onProgress({ phase: "reads-progress", done: i + slice.length, total: addrs.length });
    }
  }

  // ─── Compute per-wallet derived P&L + cohort tagging (Metric B) ───
  const walletRecords = [];
  let totalProfitable = 0, totalBreakeven = 0, totalUnderwater = 0;
  let realizedProfitCount = 0, paperProfitCount = 0, underwaterCount = 0;
  let transitCount = 0;

  // Per-facility bucket for the cohort table
  const byFacility = {};

  for (const [addr, w] of wallets) {
    const avaxIn  = Number(w.avaxInWei)  / 1e18;
    const avaxOut = Number(w.avaxOutWei) / 1e18;
    const hcashBal = Number(BigInt(w.hcashBalanceWei || "0")) / 1e18;
    const hcashSpentInGame = Number(w.hcashSpentInGameWei) / 1e18;
    const paperAvax = hcashBal * hcashAvaxSpot;
    const totalNetAvax = avaxOut + paperAvax - avaxIn;

    // ─── Cohort tagging ───
    // A wallet is a "player" if it ever entered the game OR currently has hashrate.
    // Non-players that just received/sold hCASH (CEX deposits, Magpie/aggregator
    // residuals, gifted holders) get the `transit` cohort and are excluded from
    // the P&L leaderboards (they're not what the analyst is for).
    const isPlayer = w.entries > 0 || (w.metricA?.hashrate || 0) > 0;
    let cohort;
    if (!isPlayer) {
      cohort = "transit"; transitCount++;
    } else if (avaxOut > avaxIn) {
      cohort = "realized_profit"; realizedProfitCount++;
    } else if (avaxOut + paperAvax > avaxIn) {
      cohort = "paper_profit"; paperProfitCount++;
    } else {
      cohort = "underwater"; underwaterCount++;
    }

    const ma = w.metricA;
    if (ma && isPlayer && ma.facilityIndex > 0) {
      if (ma.status === "profitable") totalProfitable++;
      else if (ma.status === "underwater") totalUnderwater++;
      else totalBreakeven++;

      const facKey = `lv${ma.facilityIndex}`;
      if (!byFacility[facKey]) {
        byFacility[facKey] = {
          facilityIndex: ma.facilityIndex,
          totalPlayers: 0,
          profitable: 0,
          breakeven: 0,
          underwater: 0,
          netHcashDayMedian: 0,
          _samples: [],
        };
      }
      const b = byFacility[facKey];
      b.totalPlayers++;
      b[ma.status]++;
      b._samples.push(ma.netHcashDay);
    }

    walletRecords.push({
      addr,
      cohort,
      isPlayer,
      operationalStatus: ma?.status || null,
      facilityLevel: ma?.facilityIndex ?? null,
      hashrate: ma?.hashrate ?? 0,
      dailyEmissionHcash: ma?.dailyEmissionHcash ?? 0,
      dailyElecHcash: ma?.dailyElecHcash ?? 0,
      netHcashDay: ma?.netHcashDay ?? 0,
      avaxIn: +avaxIn.toFixed(6),
      avaxOut: +avaxOut.toFixed(6),
      hcashBalance: +hcashBal.toFixed(4),
      hcashSpentInGame: +hcashSpentInGame.toFixed(4),
      paperAvax: +paperAvax.toFixed(6),
      netAvax: +totalNetAvax.toFixed(6),
      netUsd: +(totalNetAvax * avaxUsd).toFixed(2),
      _proof: {
        entries: w.entries,
        minerAvaxBuys: w.minerAvaxBuys,
        minerHcashBuys: w.minerHcashBuys,
        facilityUpgrades: w.facilityUpgrades,
        marketBuys: w.marketBuys,
        marketSells: w.marketSells,
        dexSells: w.dexSells,
        dexBuys: w.dexBuys,
        avaxInWei: w.avaxInWei.toString(),
        avaxOutWei: w.avaxOutWei.toString(),
        hcashSoldWei: w.hcashSoldWei.toString(),
        hcashBoughtWei: w.hcashBoughtWei.toString(),
        hcashSpentInGameWei: w.hcashSpentInGameWei.toString(),
        hcashBalanceWei: w.hcashBalanceWei || "0",
      },
    });
  }

  // Compute medians per facility
  for (const k of Object.keys(byFacility)) {
    const b = byFacility[k];
    const sorted = b._samples.slice().sort((a, c) => a - c);
    b.netHcashDayMedian = sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(4) : 0;
    delete b._samples;
  }

  // Sort leaderboards — players only (transit wallets excluded)
  const playerRecords = walletRecords.filter(w => w.isPlayer);
  const leaderboardTop = playerRecords
    .slice()
    .sort((a, b) => b.netUsd - a.netUsd)
    .slice(0, 50);
  const leaderboardBottom = playerRecords
    .slice()
    .sort((a, b) => a.netUsd - b.netUsd)
    .slice(0, 50);

  // ─── Concentration leaderboards ───
  // Top hCASH holders: who controls the supply (sell-pressure canary)
  const hcashTotalSupply = Number(boot.hcashTotalSupplyWei) / 1e18;
  const topHcashHolders = walletRecords
    .filter(w => w.hcashBalance > 0)
    .sort((a, b) => b.hcashBalance - a.hcashBalance)
    .slice(0, 50)
    .map(w => ({
      addr: w.addr,
      hcashBalance: w.hcashBalance,
      pctOfSupply: hcashTotalSupply > 0 ? +(w.hcashBalance * 100 / hcashTotalSupply).toFixed(3) : 0,
      paperAvax: w.paperAvax,
      cohort: w.cohort,
      facilityLevel: w.facilityLevel,
    }));

  // Top hashrate owners: who controls mining capacity (halving impact)
  const topHashrateOwners = walletRecords
    .filter(w => w.hashrate > 0)
    .sort((a, b) => b.hashrate - a.hashrate)
    .slice(0, 50)
    .map(w => ({
      addr: w.addr,
      hashrate: w.hashrate,
      pctOfNetwork: boot.totalHashrate > 0 ? +(w.hashrate * 100 / boot.totalHashrate).toFixed(3) : 0,
      facilityLevel: w.facilityLevel,
      dailyEmissionHcash: w.dailyEmissionHcash,
      netHcashDay: w.netHcashDay,
      operationalStatus: w.operationalStatus,
      cohort: w.cohort,
    }));

  // Compute share-of fields on the per-wallet records for /wallet/[addr] page
  for (const w of walletRecords) {
    w.pctOfSupply = hcashTotalSupply > 0 ? +(w.hcashBalance * 100 / hcashTotalSupply).toFixed(4) : 0;
    w.pctOfNetwork = boot.totalHashrate > 0 ? +(w.hashrate * 100 / boot.totalHashrate).toFixed(4) : 0;
  }

  // ─── Outputs ───
  const cohorts = {
    scannedAt: new Date().toISOString(),
    scanBlock: scanTo,
    scanFromBlock: scanFrom,
    scanGameStart: boot.gameStart,
    avaxUsd,
    hcashAvaxSpot,
    hcashUsdSpot: +(hcashAvaxSpot * avaxUsd).toFixed(6),
    initialEntryAvax,
    walletsTotal: walletRecords.length,
    playersTotal: playerRecords.length,
    network: {
      totalHashrate: boot.totalHashrate,
      hcashTotalSupply: +hcashTotalSupply.toFixed(4),
      hcashTotalSupplyWei: boot.hcashTotalSupplyWei.toString(),
    },
    // P&L cohorts — players only (excludes `transit`)
    cohortCounts: {
      realized_profit: realizedProfitCount,
      paper_profit: paperProfitCount,
      underwater: underwaterCount,
    },
    transitCount, // wallets seen that never entered the game (CEX, routers, gifted holders)
    operationalCohorts: {
      profitable: totalProfitable,
      breakeven: totalBreakeven,
      underwater: totalUnderwater,
    },
    byFacility,
    leaderboardTop,
    leaderboardBottom,
    topHcashHolders,
    topHashrateOwners,
    sources: {
      gameContract: GAME_MAIN,
      marketplaceContract: MARKETPLACE,
      hcashToken: HCASH_TOKEN,
      pharaohPair: PHARAOH_PAIR,
    },
    _validation: {
      cohortSum: realizedProfitCount + paperProfitCount + underwaterCount,
      operationalSum: totalProfitable + totalBreakeven + totalUnderwater,
      walletsRecorded: walletRecords.length,
      // The top-50s should sum to a ≤ 100% of supply / network
      top50HcashPct: topHcashHolders.reduce((s, w) => s + w.pctOfSupply, 0).toFixed(2),
      top50HashratePct: topHashrateOwners.reduce((s, w) => s + w.pctOfNetwork, 0).toFixed(2),
      durationSec: Math.round((Date.now() - startedAt) / 1000),
    },
  };

  const walletIndex = {};
  for (const w of walletRecords) walletIndex[w.addr] = w;

  saveOutputs(cohorts, walletIndex);

  onProgress({
    phase: "complete",
    wallets: walletRecords.length,
    realized: realizedProfitCount,
    paper: paperProfitCount,
    underwater: underwaterCount,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
  });

  return cohorts;
}
