// On-chain watcher: polls the game + marketplace contracts for events that
// change displayed numbers between full cron runs. Runs every 5 minutes by
// default, drops to 1 minute when activity is detected.
//
// Detects:
//   - New miner mints (MinersMintedToAddress) → drops "LIVE NOW"
//   - Facility purchases (FacilityBought) → leaderboard delta
//   - Miner purchases (MinerBought, MinerBoughtWithAvax) → leaderboard delta
//   - Cost changes (game.facilities[i].cost, game.miners[i].cost/avaxCost)
//
// Outputs:
//   data/watcher-state.json    — checkpoint (lastBlock, cadence, eventsLastRun)
//   data/leaderboard-delta.json — accumulated buys since last full profitability scan
//   data/cost-changes.json     — append-only log of detected cost deltas
//   data/launching-now.json    — miners with totalSupply==0 but contract live

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { withFailover } from "./rpc-failover.js";

const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const HC_API     = "https://api.hashcash.club/api/v1/public";

const STATE_PATH    = path.resolve("data/watcher-state.json");
const DELTA_PATH    = path.resolve("data/leaderboard-delta.json");
const COSTS_PATH    = path.resolve("data/cost-changes.json");
const LAUNCH_PATH   = path.resolve("data/launching-now.json");

const CHUNK = 2000;
const COST_LOG_MAX = 200;

// Cadence thresholds — adaptive
const FAST_THRESHOLD = 10;     // events in one run → switch to fast cadence next time
const SLOW_AFTER_QUIET = 3;    // quiet runs in a row → back to normal
const TRIGGER_RESCAN_MIN = 25; // facility upgrades in a single run → trigger full re-scan

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function saveJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function loadAbi(abiId) {
  const cache = path.resolve("data/abi-cache", `${abiId}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const res = await fetch(`${HC_API}/abis/${abiId}.json`, {
    headers: { "x-api-key": process.env.HC_API_KEY || "" },
  });
  if (!res.ok) throw new Error(`ABI ${abiId} fetch failed: ${res.status}`);
  const json = await res.json();
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(json.abi, null, 2));
  return json.abi;
}

// Scan game-contract events between two blocks, returning normalized records.
async function scanGameEvents(iface, fromBlock, toBlock) {
  const ifpTopic   = iface.getEvent("InitialFacilityPurchased").topicHash;
  const fbTopic    = iface.getEvent("FacilityBought").topicHash;
  const mbTopic    = iface.getEvent("MinerBought").topicHash;
  const mbaTopic   = iface.getEvent("MinerBoughtWithAvax").topicHash;
  // MinersMintedToAddress may or may not exist depending on ABI version
  let mintTopic = null;
  try { mintTopic = iface.getEvent("MinersMintedToAddress").topicHash; } catch { /* skip */ }

  const topicSet = [ifpTopic, fbTopic, mbTopic, mbaTopic];
  if (mintTopic) topicSet.push(mintTopic);

  const events = [];
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    try {
      const logs = await withFailover(async (provider) => {
        return provider.getLogs({
          address: GAME_MAIN,
          topics: [topicSet],
          fromBlock: "0x" + from.toString(16),
          toBlock:   "0x" + to.toString(16),
        });
      }, { label: `watcher[${from}-${to}]`, timeoutMs: 8000 });

      for (const log of logs) {
        const t0 = log.topics[0];
        const player = "0x" + log.topics[1].slice(26);
        let kind = null;
        let costWei = 0n;
        if (t0 === ifpTopic) { kind = "facility_entry"; }
        else if (t0 === fbTopic) { kind = "facility_upgrade"; costWei = BigInt("0x" + log.data.slice(2, 66)); }
        else if (t0 === mbTopic) { kind = "miner_hcash"; costWei = BigInt("0x" + log.data.slice(2, 66)); }
        else if (t0 === mbaTopic) { kind = "miner_avax"; costWei = BigInt("0x" + log.data.slice(2, 66)); }
        else if (t0 === mintTopic) { kind = "miner_mint"; }
        if (!kind) continue;
        events.push({
          kind, player, costWei: costWei.toString(),
          block: log.blockNumber, tx: log.transactionHash,
        });
      }
    } catch {
      // skip bad chunk; next run will catch up
    }
  }
  return events;
}

// Snapshot current cost fields — facilities[].cost, miners[].cost/avaxCost
async function snapshotCosts(gameAbi) {
  return withFailover(async (provider) => {
    const c = new ethers.Contract(GAME_MAIN, gameAbi, provider);
    const [facCount, minerCount] = await Promise.all([c.facilityCount(), c.uniqueMinerCount()]);
    const fc = Number(facCount);
    const mc = Number(minerCount);

    const facPromises = [];
    for (let i = 1; i <= fc; i++) facPromises.push(c.facilities(i).then(f => ({ i, cost: f.cost?.toString() ?? "0" })).catch(() => null));
    const minerPromises = [];
    for (let i = 1; i <= mc; i++) minerPromises.push(c.miners(i).then(m => ({
      i,
      cost: m.cost?.toString() ?? "0",
      avaxCost: m.avaxCost?.toString() ?? "0",
      inProduction: !!m.inProduction,
    })).catch(() => null));

    const [facs, miners] = await Promise.all([Promise.all(facPromises), Promise.all(minerPromises)]);
    return {
      facilities: Object.fromEntries(facs.filter(Boolean).map(f => [f.i, { cost: f.cost }])),
      miners:     Object.fromEntries(miners.filter(Boolean).map(m => [m.i, { cost: m.cost, avaxCost: m.avaxCost, inProduction: m.inProduction }])),
    };
  }, { label: "costSnapshot", timeoutMs: 8000 });
}

function diffCosts(prev, next) {
  const changes = [];
  if (!prev) return changes; // first run — no diff
  for (const [i, n] of Object.entries(next.facilities || {})) {
    const p = prev.facilities?.[i];
    if (!p) continue;
    if (p.cost !== n.cost) {
      const oldH = Number(BigInt(p.cost)) / 1e18;
      const newH = Number(BigInt(n.cost)) / 1e18;
      changes.push({
        kind: "facility_cost",
        facilityIndex: Number(i),
        oldHcash: oldH, newHcash: newH,
        delta: newH - oldH,
        label: newH === 0 ? `Lv.${Number(i)} upgrade is now FREE` : `Lv.${Number(i)} upgrade ${oldH.toLocaleString()} → ${newH.toLocaleString()} hCASH`,
      });
    }
  }
  for (const [i, n] of Object.entries(next.miners || {})) {
    const p = prev.miners?.[i];
    if (!p) continue;
    if (p.cost !== n.cost) {
      const oldH = Number(BigInt(p.cost)) / 1e18;
      const newH = Number(BigInt(n.cost)) / 1e18;
      changes.push({
        kind: "miner_cost_hcash",
        minerIndex: Number(i),
        oldHcash: oldH, newHcash: newH, delta: newH - oldH,
      });
    }
    if (p.avaxCost !== n.avaxCost) {
      const oldA = Number(BigInt(p.avaxCost)) / 1e18;
      const newA = Number(BigInt(n.avaxCost)) / 1e18;
      changes.push({
        kind: "miner_cost_avax",
        minerIndex: Number(i),
        oldAvax: oldA, newAvax: newA, delta: newA - oldA,
      });
    }
    if (p.inProduction !== n.inProduction) {
      changes.push({
        kind: "miner_production",
        minerIndex: Number(i),
        nowInProduction: n.inProduction,
        label: n.inProduction ? `Miner #${i} is back in production` : `Miner #${i} pulled from production`,
      });
    }
  }
  return changes;
}

// Aggregate raw events into per-wallet leaderboard deltas.
function aggregateDeltas(events, prevDelta) {
  const wallets = { ...(prevDelta?.wallets || {}) };
  for (const e of events) {
    const k = e.player.toLowerCase();
    const w = wallets[k] || { facilityUpgrades: 0, minerHcashBuys: 0, minerAvaxBuys: 0, hcashSpentWei: "0", avaxSpentWei: "0" };
    if (e.kind === "facility_upgrade") {
      w.facilityUpgrades++;
      w.hcashSpentWei = (BigInt(w.hcashSpentWei) + BigInt(e.costWei)).toString();
    } else if (e.kind === "miner_hcash") {
      w.minerHcashBuys++;
      w.hcashSpentWei = (BigInt(w.hcashSpentWei) + BigInt(e.costWei)).toString();
    } else if (e.kind === "miner_avax") {
      w.minerAvaxBuys++;
      w.avaxSpentWei = (BigInt(w.avaxSpentWei) + BigInt(e.costWei)).toString();
    }
    wallets[k] = w;
  }
  return { wallets, eventCount: (prevDelta?.eventCount || 0) + events.length, since: prevDelta?.since || new Date().toISOString() };
}

// Detect "launching now" — registry has the contract but totalSupply is 0.
async function detectLaunching() {
  const reg = await fetch(`${HC_API}/contracts`, {
    headers: { "x-api-key": process.env.HC_API_KEY || "" },
    signal: AbortSignal.timeout(15000),
  }).then(r => r.json()).catch(() => null);
  if (!reg?.contracts) return [];

  const candidates = reg.contracts.filter(c =>
    c.category === "miner_nft" && c.address && c.minerStats?.hashrateMhps > 0
  );

  const erc721 = ["function totalSupply() view returns (uint256)"];
  const launching = [];
  const BATCH = 8;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    try {
      const supplies = await withFailover(async (provider) => {
        return Promise.all(slice.map(async (c) => {
          try {
            const nft = new ethers.Contract(c.address, erc721, provider);
            const s = await nft.totalSupply();
            return { c, supply: Number(s) };
          } catch { return null; }
        }));
      }, { label: `launchSupply[${i}]`, timeoutMs: 5000 });
      for (const r of supplies) {
        if (r && r.supply === 0) {
          launching.push({
            id: r.c.id, name: r.c.name, address: r.c.address,
            hashrateMhps: r.c.minerStats.hashrateMhps,
            powerWatts:   r.c.minerStats.powerWatts,
            img: r.c.imageUrl || null,
            detectedAt: new Date().toISOString(),
          });
        }
      }
    } catch { /* skip */ }
  }
  return launching;
}

export async function runWatcher() {
  const startedAt = Date.now();
  const state = loadJson(STATE_PATH, { lastBlock: null, cadenceMin: 5, quietRuns: 0 });
  const prevDelta = loadJson(DELTA_PATH, null);
  const prevCosts = loadJson(COSTS_PATH, null)?.lastSnapshot || null;
  const costLog   = loadJson(COSTS_PATH, { changes: [] }).changes || [];

  const gameAbi = await loadAbi("main.v1");
  const gameIface = new ethers.Interface(gameAbi);

  // Anchor block — current head
  const head = await withFailover(p => p.getBlockNumber(), { label: "head" });
  const lastBlock = state.lastBlock ?? Number(head) - 600; // first run: last ~10 min
  const fromBlock = lastBlock + 1;
  const toBlock = Number(head);

  // 1. Event scan
  let events = [];
  if (toBlock >= fromBlock) {
    events = await scanGameEvents(gameIface, fromBlock, toBlock);
  }

  // 2. Cost snapshot diff
  const nextCosts = await snapshotCosts(gameAbi);
  const costChanges = diffCosts(prevCosts, nextCosts);

  // 3. Launching detection
  const launching = await detectLaunching();
  saveJson(LAUNCH_PATH, { updatedAt: new Date().toISOString(), launching });

  // 4. Update leaderboard delta
  const delta = aggregateDeltas(events, prevDelta);
  delta.lastBlock = toBlock;
  delta.lastUpdated = new Date().toISOString();
  saveJson(DELTA_PATH, delta);

  // 5. Append cost changes to log (capped)
  let mergedLog = costLog;
  if (costChanges.length > 0) {
    const stamped = costChanges.map(c => ({ ...c, detectedAt: new Date().toISOString(), block: toBlock }));
    mergedLog = [...stamped, ...costLog].slice(0, COST_LOG_MAX);
  }
  saveJson(COSTS_PATH, { updatedAt: new Date().toISOString(), lastSnapshot: nextCosts, changes: mergedLog });

  // 6. Adaptive cadence
  const facilityUpgrades = events.filter(e => e.kind === "facility_upgrade").length;
  const triggerRescan = facilityUpgrades >= TRIGGER_RESCAN_MIN;
  let cadenceMin = state.cadenceMin;
  let quietRuns = state.quietRuns;
  if (events.length >= FAST_THRESHOLD) {
    cadenceMin = 1; quietRuns = 0;
  } else if (events.length === 0) {
    quietRuns++;
    if (quietRuns >= SLOW_AFTER_QUIET) cadenceMin = 5;
  } else {
    quietRuns = 0;
  }

  saveJson(STATE_PATH, {
    lastBlock: toBlock, cadenceMin, quietRuns,
    eventsLastRun: events.length, costChangesLastRun: costChanges.length,
    launchingLastRun: launching.length,
    lastRunAt: new Date().toISOString(),
    lastRunDurationMs: Date.now() - startedAt,
  });

  return {
    fromBlock, toBlock, eventCount: events.length,
    facilityUpgrades, costChanges, launching,
    triggerRescan, cadenceMin,
  };
}

export function loadWatcherState() { return loadJson(STATE_PATH, null); }
export function loadDelta() { return loadJson(DELTA_PATH, null); }
export function loadCostChanges() { return loadJson(COSTS_PATH, { changes: [] }); }
export function loadLaunching() { return loadJson(LAUNCH_PATH, { launching: [] }); }
