import { NextResponse } from "next/server";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";
import { loadIntegrityIssues } from "@/lib/registry-integrity.js";
import { fireStaleCronsInBackground, describeStaleness } from "@/lib/fire-if-stale.js";
import { getJson, KEYS, isBlobMode } from "@/lib/storage.js";

// Single endpoint that serves everything written by the on-chain watcher and
// the registry-integrity validator. The page polls this every minute so the
// UI can surface cost changes, launching drops, integrity gaps, and the
// in-flight leaderboard delta without waiting for the daily/2-hour crons.

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 60, windowMs: 60_000 })) return tooManyRequests();
  // Organic cron-bypass: client polls /api/live every 60s, so this becomes
  // our "heartbeat" path that keeps watcher/registry fresh on Hobby tier.
  const fired = await fireStaleCronsInBackground(req);

  const [state, delta, costs, launch, issues, staleness] = await Promise.all([
    getJson(KEYS.WATCHER_STATE, null),
    getJson(KEYS.LEADERBOARD_DELTA, null),
    getJson(KEYS.COST_CHANGES, { changes: [] }),
    getJson(KEYS.LAUNCHING, { launching: [] }),
    loadIntegrityIssues(),
    describeStaleness(),
  ]);

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    storageMode: isBlobMode() ? "blob" : "fs",
    firedThisRequest: fired,
    watcher: state ? {
      lastBlock: state.lastBlock,
      lastRunAt: state.lastRunAt,
      cadenceMin: state.cadenceMin,
      eventsLastRun: state.eventsLastRun,
    } : null,
    leaderboardDelta: delta ? {
      lastBlock: delta.lastBlock,
      lastUpdated: delta.lastUpdated,
      walletsAffected: Object.keys(delta.wallets || {}).length,
      eventCount: delta.eventCount || 0,
      wallets: delta.wallets || {},
    } : null,
    costChanges: (costs?.changes || []).slice(0, 20),
    launching: launch?.launching || [],
    integrityIssues: issues,
    staleness,
  }, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" },
  });
}
