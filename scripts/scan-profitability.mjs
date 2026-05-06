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

  let backupDir = null; // set if we wipe; used to restore on crash

  if (flag("full")) {
    // Confirmation gate — interactive unless --yes-wipe is also passed (CI)
    if (!flag("yes-wipe")) {
      console.log("[scan] --full will DELETE existing scan-checkpoint, profitability-cohorts, wallet-pnl.");
      console.log("[scan] These will be backed up to data/.backups/<timestamp>/ first.");
      process.stdout.write("[scan] Type 'yes-wipe' to continue: ");
      const answer = await new Promise(r => {
        process.stdin.once('data', d => r(d.toString().trim()));
      });
      if (answer !== 'yes-wipe') {
        console.log("[scan] aborted — no files touched.");
        process.exit(0);
      }
    }

    // Backup BEFORE wipe — restorable if anything fails
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupDir = path.resolve("data/.backups", ts);
    fs.mkdirSync(backupDir, { recursive: true });
    const targets = ["scan-checkpoint.json", "profitability-cohorts.json", "wallet-pnl.json"];
    for (const f of targets) {
      const src = path.resolve("data", f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, f));
        fs.unlinkSync(src);
      }
    }
    console.log(`[scan] --full: backed up to ${backupDir}, wiped, starting fresh from gameStart()`);

    // Prune backups older than 5 most-recent
    try {
      const root = path.resolve("data/.backups");
      if (fs.existsSync(root)) {
        const entries = fs.readdirSync(root)
          .map(name => ({ name, mtime: fs.statSync(path.join(root, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        for (const old of entries.slice(5)) {
          fs.rmSync(path.join(root, old.name), { recursive: true, force: true });
        }
      }
    } catch { /* best-effort prune */ }

    fromBlock = null; // null + no checkpoint → runScan defaults to gameStart
  } else if (arg("range")) {
    const n = parseInt(arg("range"), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error("--range must be a positive integer");
    const latest = await withFailover(p => p.getBlockNumber(), { label: "head" });
    fromBlock = Math.max(0, Number(latest) - n);
    toBlock = Number(latest);
    console.log(`[scan] --range ${n} → blocks ${fromBlock} to ${toBlock}`);
  } else {
    const cp = await loadCheckpoint();
    if (cp?.lastProcessedBlock) {
      console.log(`[scan] resuming from checkpoint at block ${cp.lastProcessedBlock}`);
    } else {
      console.log("[scan] no checkpoint found; starting from gameStart()");
    }
  }

  const t0 = Date.now();
  try {
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
  } catch (scanErr) {
    // Restore from backup if --full wiped files and the scan crashed mid-way
    if (backupDir && fs.existsSync(backupDir)) {
      console.error(`\n[scan] FAILED — restoring from backup ${backupDir}`);
      try {
        for (const f of fs.readdirSync(backupDir)) {
          fs.copyFileSync(path.join(backupDir, f), path.resolve("data", f));
        }
        console.error("[scan] restore complete — your previous data is intact");
      } catch (restoreErr) {
        console.error("[scan] RESTORE ALSO FAILED:", restoreErr.message);
        console.error(`[scan] manual restore: copy files from ${backupDir} to data/`);
      }
    }
    throw scanErr; // re-throw so outer catch logs and exits non-zero
  }
})().catch(err => {
  console.error("[scan] FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});

function pct(num, denom) {
  return denom > 0 ? `${(num * 100 / denom).toFixed(1)}%` : "—";
}
