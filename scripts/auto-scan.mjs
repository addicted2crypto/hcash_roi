// Auto-scan runner — calls the decider, runs the right scan mode, validates output.
//
// Usage:
//   node scripts/auto-scan.mjs           # decide automatically
//   node scripts/auto-scan.mjs --full    # force full (still backs up + confirms in interactive mode)
//   node scripts/auto-scan.mjs --skip    # decide skip (no-op, used to test exit path)
//   node scripts/auto-scan.mjs --dry-run # decide and print, do NOT run scan
//
// In CI / GitHub Actions, set --yes-wipe to bypass the confirmation prompt
// when a 'full' decision is made.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runScan, loadCheckpoint } from '../lib/profitability-scan.js';
import { withFailover } from '../lib/rpc-failover.js';
import { decideScanMode } from '../lib/scan-decider.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);

// gameStart hardcoded — querying it requires an extra RPC round; this constant
// matches what the contract returns and rarely changes (would only change on a
// contract migration, which would warrant a code change anyway).
const GAME_START_BLOCK = 77832296;

function loadCohortCounts() {
  const p = path.resolve('data/profitability-cohorts.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data?.cohortCounts || null;
  } catch { return null; }
}

(async () => {
  const t0 = Date.now();
  const checkpoint = await loadCheckpoint();
  const latestBlock = Number(await withFailover(p => p.getBlockNumber(), { label: 'head' }));
  const lastCohortCounts = loadCohortCounts();

  const forceMode = flag('full') ? 'full' : flag('skip') ? 'skip' : null;
  const decision = decideScanMode({
    checkpoint,
    latestBlock,
    gameStart: GAME_START_BLOCK,
    lastCohortCounts,
    currentCohortCounts: null, // populated below for post-scan recheck
    forceMode,
  });

  console.log(`[auto-scan] decision: ${decision.mode}`);
  for (const r of decision.reasons) console.log(`[auto-scan]   reason: ${r}`);

  if (flag('dry-run')) {
    console.log('[auto-scan] --dry-run — exiting without running scan');
    process.exit(0);
  }

  if (decision.mode === 'skip') {
    console.log('[auto-scan] nothing to do.');
    process.exit(0);
  }

  // For 'full', defer to scan-profitability.mjs which has backup-before-wipe.
  // BUT: in CI, a full scan typically exceeds the 30-min runner budget. SIGKILL
  // from the runner skips our catch/restore handler, leaving files wiped.
  // So in CI mode we REFUSE to auto-fire full; it must be run manually with eyes-on.
  if (decision.mode === 'full') {
    if (flag('ci-mode') || process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
      console.error('[auto-scan] FULL scan needed but running in CI — refusing to auto-wipe.');
      console.error('[auto-scan] Reason was:', decision.reasons.join('; '));
      console.error('[auto-scan] To run a full scan, do it locally:');
      console.error('[auto-scan]   FORCE_LOCAL_STORAGE=1 node scripts/scan-profitability.mjs --full');
      console.error('[auto-scan] then commit and push the resulting data files.');
      process.exit(2); // distinct exit code so CI logs flag this clearly
    }
    const { spawnSync } = await import('node:child_process');
    const childArgs = ['scripts/scan-profitability.mjs', '--full'];
    if (flag('yes-wipe')) childArgs.push('--yes-wipe');
    console.log(`[auto-scan] delegating full rescan to scan-profitability.mjs ${childArgs.join(' ')}`);
    const res = spawnSync('node', childArgs, { stdio: 'inherit' });
    process.exit(res.status ?? 1);
  }

  // Incremental: resume from checkpoint, no wipe needed
  console.log(`[auto-scan] running incremental scan from block ${checkpoint.lastProcessedBlock} → ${latestBlock}`);
  await runScan({
    fromBlock: null, // null + valid checkpoint → resume from checkpoint
    onProgress: (e) => {
      const t = ((Date.now() - t0) / 1000).toFixed(1);
      switch (e.phase) {
        case 'boot':
          console.log(`[${t}s] boot: scanning blocks ${e.scanFrom}–${e.scanTo}`);
          break;
        case 'checkpoint':
          console.log(`[${t}s] chunk ${e.processedChunks}/${e.totalChunks} · block ${e.to} · ${e.wallets} wallets · ${e.events} events`);
          break;
        case 'reads-progress':
          console.log(`[${t}s] reads ${e.done}/${e.total} (${Math.round(100 * e.done / e.total)}%)`);
          break;
        case 'complete':
          console.log(`[${t}s] complete: ${e.wallets} wallets · realized=${e.realized} paper=${e.paper} underwater=${e.underwater}`);
          break;
      }
    },
  });

  // Post-scan validation: re-load cohort counts, check drift
  const newCohortCounts = loadCohortCounts();
  if (lastCohortCounts && newCohortCounts) {
    const recheck = decideScanMode({
      checkpoint: await loadCheckpoint(),
      latestBlock,
      gameStart: GAME_START_BLOCK,
      lastCohortCounts,
      currentCohortCounts: newCohortCounts,
    });
    if (recheck.mode === 'full') {
      console.warn(`[auto-scan] WARNING: post-scan drift check would have triggered FULL — ${recheck.reasons.join(', ')}`);
      console.warn('[auto-scan] this run was incremental but next run will be full');
    }
  }

  console.log(`[auto-scan] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(err => {
  console.error('[auto-scan] FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
