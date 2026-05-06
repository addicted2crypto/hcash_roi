// Pure decision logic for the auto-scan pipeline.
//
// Given the current state (last checkpoint, chain head, optional cohort drift
// inputs), returns a decision: 'full' / 'incremental' / 'skip', with reasons.
//
// No I/O, no side effects. Designed to be unit-testable with synthetic inputs
// and easy to extend with new triggers without touching the rest of the system.
//
// Usage:
//   const decision = decideScanMode({ checkpoint, latestBlock, gameStart });
//   // decision = { mode: 'incremental', reasons: ['standard daily refresh'] }

// Tunable thresholds — single place to adjust pipeline behavior
export const DECIDER_DEFAULTS = {
  // If checkpoint is more than this many blocks behind head, force a full rescan.
  // Rationale: incremental scans can miss subtle event-ordering edge cases when
  // catching up huge gaps. Better to rebuild from scratch if we're way behind.
  // 500k blocks ≈ 6 days at Avalanche cadence.
  staleBlocksThreshold: 500_000,

  // If the chain has advanced fewer than this many blocks since last scan,
  // skip the run entirely. Saves CI minutes when triggered too frequently.
  // 100 blocks ≈ 2 minutes — anything less is noise.
  minBlocksToScan: 100,

  // If cohort counts swing more than this fraction (e.g. 0.5 = 50%) between
  // consecutive scans, treat as suspicious and force a full rescan. Day-to-day
  // drift on this game is normally <5%; >50% is a red flag.
  suspiciousCohortDrift: 0.5,
};

// Compare two cohort-count maps, return max relative drift across keys.
// Returns 0 if either input is missing or empty (caller falls back to default).
export function computeCohortDrift(prev, current) {
  if (!prev || !current) return 0;
  const keys = new Set([...Object.keys(prev), ...Object.keys(current)]);
  let maxDrift = 0;
  for (const k of keys) {
    const p = Number(prev[k] || 0);
    const c = Number(current[k] || 0);
    const denom = Math.max(p, 1); // avoid div-by-zero, treat 0→N as 100% drift
    const drift = Math.abs(c - p) / denom;
    if (drift > maxDrift) maxDrift = drift;
  }
  return maxDrift;
}

export function decideScanMode({
  checkpoint,
  latestBlock,
  gameStart,
  lastCohortCounts = null,
  currentCohortCounts = null,
  forceMode = null,           // 'full' | 'incremental' | 'skip' | null
  thresholds = DECIDER_DEFAULTS,
} = {}) {
  // Manual override — useful for the `--full` flag and emergency overrides
  if (forceMode === 'full' || forceMode === 'incremental' || forceMode === 'skip') {
    return { mode: forceMode, reasons: [`manual override: ${forceMode}`] };
  }

  // Validate required inputs
  if (typeof latestBlock !== 'number' || latestBlock <= 0) {
    return { mode: 'full', reasons: ['latestBlock not provided — cannot compute decision'] };
  }
  if (typeof gameStart !== 'number' || gameStart <= 0) {
    return { mode: 'full', reasons: ['gameStart not provided — cannot compute decision'] };
  }

  // 1. No checkpoint → full
  if (!checkpoint || !checkpoint.lastProcessedBlock) {
    return { mode: 'full', reasons: ['no valid checkpoint — first run or corrupted'] };
  }

  const lastBlock = Number(checkpoint.lastProcessedBlock);
  if (!Number.isFinite(lastBlock) || lastBlock <= 0) {
    return { mode: 'full', reasons: ['checkpoint.lastProcessedBlock invalid — corrupted'] };
  }

  // 2. Checkpoint pre-dates game → full (different network, contract reset)
  if (lastBlock < gameStart) {
    return { mode: 'full', reasons: [`checkpoint at block ${lastBlock} pre-dates gameStart ${gameStart}`] };
  }

  // 3. Checkpoint dangerously stale → full (incremental might miss things)
  const blocksBehind = latestBlock - lastBlock;
  if (blocksBehind > thresholds.staleBlocksThreshold) {
    return {
      mode: 'full',
      reasons: [`${blocksBehind} blocks behind head — exceeds staleBlocksThreshold ${thresholds.staleBlocksThreshold}`],
    };
  }

  // 4. Nothing meaningful to scan → skip
  if (blocksBehind < thresholds.minBlocksToScan) {
    return {
      mode: 'skip',
      reasons: [`only ${blocksBehind} new blocks since last scan — below minBlocksToScan ${thresholds.minBlocksToScan}`],
    };
  }

  // 5. Suspicious cohort drift → full (data integrity safeguard)
  if (lastCohortCounts && currentCohortCounts) {
    const drift = computeCohortDrift(lastCohortCounts, currentCohortCounts);
    if (drift > thresholds.suspiciousCohortDrift) {
      return {
        mode: 'full',
        reasons: [`cohort drift ${(drift * 100).toFixed(1)}% exceeds suspiciousCohortDrift ${(thresholds.suspiciousCohortDrift * 100)}%`],
      };
    }
  }

  // Default: incremental from checkpoint
  return {
    mode: 'incremental',
    reasons: [`incremental scan: ${blocksBehind} blocks since checkpoint at ${lastBlock}`],
  };
}
