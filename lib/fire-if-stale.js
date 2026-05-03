// Fire-if-stale: organic "extra cron" path that bypasses Vercel Hobby's
// daily-only cron limit. When a user loads the page, we check whether the
// watcher / registry / profitability outputs are older than their freshness
// budget. If yes, we fire the corresponding cron route in the background
// (no await) so the next visitor sees fresh data.
//
// Critical guarantees:
//  - Never blocks the user's request (all triggers fire-and-forget)
//  - Never fires a route more than once per `coolDownMs` (in-memory dedupe)
//  - Each fire is gated by CRON_SECRET — auth identical to scheduled crons
//  - If we're missing CRON_SECRET, we skip silently (local dev safe)

import fs from "node:fs";
import path from "node:path";

// In-memory dedupe so we don't fire the same route 50 times per second
// during a traffic spike. Resets on cold start (acceptable — that just
// means the first request after a cold start gets to fire).
const lastFiredAt = new Map();

const ROUTES = {
  watcher: {
    path: "/api/cron/watcher",
    statePath: path.resolve("data/watcher-state.json"),
    stateField: "lastRunAt",
    freshnessMs: 15 * 60 * 1000,   // poke every 15 min when traffic exists
    coolDownMs:  10 * 60 * 1000,
  },
  registry: {
    path: "/api/cron/registry",
    statePath: path.resolve("data/registry-snapshot.json"),
    stateField: "capturedAt",
    freshnessMs: 60 * 60 * 1000,   // poke hourly when traffic exists
    coolDownMs:  30 * 60 * 1000,
  },
  // profitability is intentionally not in the auto-fire list — that scan can
  // run for many minutes and shouldn't be triggered organically by visitors.
  // Daily cron at 06:00 UTC is its only trigger; manual re-run via /api/cron/profitability with auth header is the escape hatch.
};

function readJsonField(filePath, field) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw?.[field] ?? null;
  } catch { return null; }
}

function ageOf(filePath, field) {
  const ts = readJsonField(filePath, field);
  if (!ts) return Infinity;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

// Determine the public origin of this deployment so we can self-call.
// Vercel sets VERCEL_URL automatically (e.g. "hcash-roi.vercel.app").
// In local dev we fall back to localhost:3000.
function selfOrigin(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const host = req?.headers?.get?.("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") || "http";
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

// Fire one route in the background. Returns immediately.
// We do NOT await the response — the user's request must not be blocked.
function fireBackground(origin, routePath) {
  const url = `${origin}${routePath}`;
  const secret = process.env.CRON_SECRET;
  if (!secret) return; // local dev without secret — skip silently

  // fetch().catch() so any network/auth error is swallowed; we don't surface to UI
  fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
    // Don't keep the function alive waiting for this — Vercel will let it
    // run for up to maxDuration on the cron route itself.
    signal: AbortSignal.timeout(2000),
  }).catch(() => { /* ignore */ });
}

// Check all routes; fire any that are stale and not in cooldown.
// Call this from any server context (page render, API route, etc.).
export function fireStaleCronsInBackground(req) {
  const now = Date.now();
  const origin = selfOrigin(req);
  const fired = [];

  for (const [name, cfg] of Object.entries(ROUTES)) {
    const last = lastFiredAt.get(name) || 0;
    if (now - last < cfg.coolDownMs) continue;          // recently fired
    const age = ageOf(cfg.statePath, cfg.stateField);
    if (age < cfg.freshnessMs) continue;                 // still fresh
    lastFiredAt.set(name, now);
    fireBackground(origin, cfg.path);
    fired.push({ name, ageMinBeforeFire: Math.round(age / 60000) });
  }

  return fired;
}

// Read-only inspector for the live API route — lets the UI show "last fired"
// state without triggering anything.
export function describeStaleness() {
  const out = {};
  for (const [name, cfg] of Object.entries(ROUTES)) {
    const age = ageOf(cfg.statePath, cfg.stateField);
    out[name] = {
      ageMs: age === Infinity ? null : age,
      ageMinutes: age === Infinity ? null : Math.round(age / 60000),
      stale: age >= cfg.freshnessMs,
      lastFiredAt: lastFiredAt.get(name) ?? null,
    };
  }
  return out;
}
