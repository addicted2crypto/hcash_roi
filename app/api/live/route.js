import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";
import { loadIntegrityIssues } from "@/lib/registry-integrity.js";

// Single endpoint that serves everything written by the on-chain watcher and
// the registry-integrity validator. The page polls this every minute so the
// UI can surface cost changes, launching drops, integrity gaps, and the
// in-flight leaderboard delta without waiting for the daily/2-hour crons.

const STATE_PATH  = path.resolve("data/watcher-state.json");
const DELTA_PATH  = path.resolve("data/leaderboard-delta.json");
const COSTS_PATH  = path.resolve("data/cost-changes.json");
const LAUNCH_PATH = path.resolve("data/launching-now.json");

function safeLoad(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 60, windowMs: 60_000 })) return tooManyRequests();

  const state    = safeLoad(STATE_PATH,  null);
  const delta    = safeLoad(DELTA_PATH,  null);
  const costs    = safeLoad(COSTS_PATH,  { changes: [] });
  const launch   = safeLoad(LAUNCH_PATH, { launching: [] });
  const issues   = loadIntegrityIssues();

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
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
    costChanges: (costs.changes || []).slice(0, 20),
    launching: launch.launching || [],
    integrityIssues: issues,
  }, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" },
  });
}
