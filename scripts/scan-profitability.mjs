// CLI runner for the profitability scan.
//   node scripts/scan-profitability.mjs           — incremental from checkpoint, default
//   node scripts/scan-profitability.mjs --full    — from gameStart()
//   node scripts/scan-profitability.mjs --range 1000 — last N blocks only (smoke test)
//
// Outputs:
//   data/profitability-cohorts.json
//   data/wallet-pnl.json
//   data/scan-checkpoint.json (for resumability)

import 'dotenv/config';
import fs from "node:fs";
import path from "node:path";
import { runScan, loadCheckpoint } from "../lib/profitability-scan.js";
import { withFailover } from "../lib/rpc-failover.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

(async () => {
  let fromBlock = null;
  let toBlock = null;

  if (flag("full")) {
    // Wipe checkpoint + outputs so the scan truly starts fresh from gameStart
    for (const f of ["scan-checkpoint.json", "profitability-cohorts.json", "wallet-pnl.json"]) {
      const p = path.resolve("data", f);
      if (fs.existsSync(p)) { fs.unlinkSync(p); }
    }
    fromBlock = null; // null + no checkpoint → runScan defaults to gameStart
    console.log("[scan] --full requested; checkpoint cleared, starting from gameStart()");
  } else if (arg("range")) {
    const n = parseInt(arg("range"), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error("--range must be a positive integer");
    const latest = await withFailover(p => p.getBlockNumber(), { label: "head" });
    fromBlock = Math.max(0, Number(latest) - n);
    toBlock = Number(latest);
    console.log(`[scan] --range ${n} → blocks ${fromBlock} to ${toBlock}`);
  } else {
    const cp = loadCheckpoint();
    if (cp?.lastProcessedBlock) {
      console.log(`[scan] resuming from checkpoint at block ${cp.lastProcessedBlock}`);
    } else {
      console.log("[scan] no checkpoint found; starting from gameStart()");
    }
  }

  const t0 = Date.now();
  await runScan({
    fromBlock,
    toBlock,
    saveEvery: 3,
    onProgress: (e) => {
      const t = ((Date.now() - t0) / 1000).toFixed(1);
      switch (e.phase) {
        case "boot":
          console.log(`[${t}s] boot: scanning blocks ${e.scanFrom}–${e.scanTo} (game started at ${e.gameStart}, entry cost ${e.initialEntryAvax} AVAX)`);
          break;
        case "checkpoint":
          console.log(`[${t}s] chunk ${e.processedChunks}/${e.totalChunks} · block ${e.to} · ${e.wallets} wallets · ${e.events} events`);
          break;
        case "chunk-skip":
          console.log(`[${t}s] WARN: ${e.source} chunk skipped at ${e.from}-${e.to}: ${e.err}`);
          break;
        case "reads-begin":
          console.log(`[${t}s] event scan complete; now reading per-wallet contract state for ${e.wallets} wallets`);
          break;
        case "reads-progress":
          console.log(`[${t}s] reads ${e.done}/${e.total} (${Math.round(100*e.done/e.total)}%)`);
          break;
        case "reads-skip":
          console.log(`[${t}s] WARN: read batch ${e.at} skipped: ${e.err}`);
          break;
        case "complete":
          console.log("");
          console.log("════════════════════════════════════════════════════════════════");
          console.log(`SCAN COMPLETE in ${e.durationSec}s`);
          console.log(`  Total wallets: ${e.wallets}`);
          console.log(`  Realized profit: ${e.realized}  (${pct(e.realized, e.wallets)})`);
          console.log(`  Paper profit:    ${e.paper}  (${pct(e.paper, e.wallets)})`);
          console.log(`  Underwater:      ${e.underwater}  (${pct(e.underwater, e.wallets)})`);
          console.log("════════════════════════════════════════════════════════════════");
          break;
      }
    },
  });

  console.log(`\nOutputs:`);
  console.log(`  data/profitability-cohorts.json`);
  console.log(`  data/wallet-pnl.json`);
  console.log(`  data/scan-checkpoint.json`);
})().catch(err => {
  console.error("[scan] FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});

function pct(num, denom) {
  return denom > 0 ? `${(num * 100 / denom).toFixed(1)}%` : "—";
}
