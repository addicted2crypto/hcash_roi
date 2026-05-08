// Verify the "All the active facilities" number that frostbyte's site shows.
// Tests three methodologies against the canonical contract:
//   A. Total unique addresses that ever fired InitialFacilityPurchased (historical)
//   B. Addresses currently owning a facility per ownerToFacility().facilityIndex > 0
//   C. uniqueFacilityCount or similar contract-level counter, if exposed
//
// Run from repo root: node scripts/verify-facility-count.mjs

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { withFailover } from "../lib/rpc-failover.js";

const GAME_MAIN = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const CHUNK = 2000;

const abiPath = path.resolve("data/abi-cache/main.v1.json");
if (!fs.existsSync(abiPath)) {
  console.error("Missing ABI cache at", abiPath);
  process.exit(1);
}
const abi = JSON.parse(fs.readFileSync(abiPath, "utf8"));
const iface = new ethers.Interface(abi);

const t0 = Date.now();
function elapsed() { return ((Date.now() - t0) / 1000).toFixed(1) + "s"; }

const PROGRESS_PATH = path.resolve("data/_verify-facility-progress.txt");
function log(msg) {
  const line = `[${elapsed()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(PROGRESS_PATH, line); } catch {}
}
// Wipe progress file at start
try { fs.writeFileSync(PROGRESS_PATH, ""); } catch {}

(async () => {
  // Bootstrap
  const boot = await withFailover(async (provider) => {
    const c = new ethers.Contract(GAME_MAIN, abi, provider);
    const [head, startBlock] = await Promise.all([
      provider.getBlockNumber(),
      c.startBlock(),
    ]);
    return { head: Number(head), startBlock: Number(startBlock) };
  }, { label: "boot" });
  log(`[${elapsed()}] boot: scanning blocks ${boot.startBlock} → ${boot.head} (${boot.head - boot.startBlock} blocks)`);

  // C. Try contract-level counters that might exist
  const candidateCounters = [
    "uniqueFacilityCount", "totalFacilities", "facilitiesCount",
    "playerCount", "uniquePlayerCount", "totalPlayers",
  ];
  for (const fn of candidateCounters) {
    if (!abi.find(x => x.name === fn && x.type === "function")) continue;
    try {
      const v = await withFailover(async (p) => {
        const c = new ethers.Contract(GAME_MAIN, abi, p);
        return await c[fn]();
      }, { label: fn });
      log(`  contract.${fn}() = ${Number(v)}`);
    } catch (e) {
      log(`  contract.${fn}() failed: ${e.message?.slice(0, 80)}`);
    }
  }

  // A. Historical InitialFacilityPurchased addresses
  const ifpTopic = iface.getEvent("InitialFacilityPurchased").topicHash;
  const allEntries = new Set();

  let processed = 0;
  for (let from = boot.startBlock; from <= boot.head; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, boot.head);
    try {
      const logs = await withFailover(async (provider) => {
        return provider.getLogs({
          address: GAME_MAIN,
          topics: [ifpTopic],
          fromBlock: "0x" + from.toString(16),
          toBlock:   "0x" + to.toString(16),
        });
      }, { label: `ifp[${from}-${to}]`, timeoutMs: 8000 });
      for (const log of logs) {
        const addr = "0x" + log.topics[1].slice(26);
        allEntries.add(addr.toLowerCase());
      }
    } catch (e) {
      log(`  chunk skip ${from}-${to}: ${String(e).slice(0, 80)}`);
    }
    processed++;
    if (processed % 25 === 0) {
      log(`[${elapsed()}] event scan ${from}/${boot.head} · ${allEntries.size} unique entries so far`);
    }
  }
  log(`\n[${elapsed()}] METHODOLOGY A — historical InitialFacilityPurchased: ${allEntries.size} unique addresses`);

  // B. Currently owning a facility (ownerToFacility().facilityIndex > 0)
  log(`\n[${elapsed()}] checking ownerToFacility() for ${allEntries.size} addresses...`);
  const addrs = [...allEntries];
  const READ_BATCH = 12;
  let stillOwn = 0;
  let byLevel = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (let i = 0; i < addrs.length; i += READ_BATCH) {
    const slice = addrs.slice(i, i + READ_BATCH);
    try {
      const reads = await withFailover(async (provider) => {
        const c = new ethers.Contract(GAME_MAIN, abi, provider);
        return Promise.all(slice.map(async (a) => {
          try { return { a, otf: await c.ownerToFacility(a) }; }
          catch { return null; }
        }));
      }, { label: `otf[${i}]`, timeoutMs: 8000 });
      for (const r of reads) {
        if (!r) continue;
        const idx = Number(r.otf.facilityIndex);
        byLevel[idx] = (byLevel[idx] || 0) + 1;
        if (idx > 0) stillOwn++;
      }
    } catch (e) {
      log(`  read batch ${i} skip: ${String(e).slice(0, 80)}`);
    }
    if ((i / READ_BATCH) % 10 === 0) {
      log(`[${elapsed()}] reads ${i + slice.length}/${addrs.length} · currently owning: ${stillOwn}`);
    }
  }

  log(`\n════════════════════════════════════════════════`);
  log(`RESULTS @ block ${boot.head}`);
  log(`════════════════════════════════════════════════`);
  log(`A. Historical IFP addresses (ever entered):     ${allEntries.size}`);
  log(`B. Currently own a facility (idx > 0):          ${stillOwn}`);
  log(`   By level: Lv.0=${byLevel[0]} Lv.1=${byLevel[1]} Lv.2=${byLevel[2]} Lv.3=${byLevel[3]} Lv.4=${byLevel[4]} Lv.5=${byLevel[5]} Lv.6=${byLevel[6]||0}`);
  log(`════════════════════════════════════════════════`);
  log(`frostbyte's reported 747 — match candidate:`);
  if (allEntries.size === 747) log(`  → A (historical IFP)`);
  else if (stillOwn === 747) log(`  → B (currently own)`);
  else log(`  → NEITHER. A=${allEntries.size}, B=${stillOwn}, frostbyte=747. Different aggregator.`);
  log(`════════════════════════════════════════════════`);
})().catch(err => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
