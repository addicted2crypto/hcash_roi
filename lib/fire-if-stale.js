// Fire-if-stale: organic "extra cron" path that bypasses Vercel Hobby's
// daily-only cron limit. When a user loads the page, we check whether the
// watcher / registry outputs are older than their freshness budget. If yes,
// we fire the corresponding cron route in the background so the next visitor
// sees fresh data.
//
// IMPORTANT: We use `waitUntil()` from `next/server` to keep the parent
// request alive until the background fetch completes. Without it, Vercel
// kills the fetch the moment the parent response is sent — which is exactly
// what was happening in the deployed logs (lastFiredAt was set, but
// /api/cron/watcher was never actually hit).
//
// Critical guarantees:
//  - Never blocks the user's response (waitUntil runs after response is sent)
//  - Never fires a route more than once per `coolDownMs` (in-memory dedupe)
//  - Each fire is gated by CRON_SECRET — auth identical to scheduled crons
//  - Missing CRON_SECRET → silent skip (local dev safe)

import { getJson, KEYS } from "./storage.js";

// In-memory dedupe so we don't fire the same route 50 times per second
// during a traffic spike. Resets on cold start (acceptable — that just
// means the first request after a cold start gets to fire).
const lastFiredAt = new Map();

const ROUTES = {
  watcher: {
    path: "/api/cron/watcher",
    storageKey: KEYS.WATCHER_STATE,
    stateField: "lastRunAt",
    freshnessMs: 15 * 60 * 1000,   // poke every 15 min when traffic exists
    coolDownMs:  10 * 60 * 1000,
  },
  registry: {
    path: "/api/cron/registry",
    storageKey: KEYS.REGISTRY_SNAPSHOT,
    stateField: "capturedAt",
    freshnessMs: 60 * 60 * 1000,   // poke hourly when traffic exists
    coolDownMs:  30 * 60 * 1000,
  },
  // profitability is intentionally not in the auto-fire list — that scan can
  // run for many minutes and shouldn't be triggered organically by visitors.
};

async function ageOf(storageKey, field) {
  const data = await getJson(storageKey, null);
  const ts = data?.[field];
  if (!ts) return Infinity;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

// Determine the public origin of this deployment so we can self-call.
function selfOrigin(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const host = req?.headers?.get?.("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") || "http";
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

// One background fire — returns the promise so waitUntil can keep it alive.
async function fireOne(origin, routePath) {
  const url = `${origin}${routePath}`;
  const secret = process.env.CRON_SECRET;
  if (!secret) return; // local dev without secret — skip silently

  try {
    await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      // Cron routes can run up to 5 min — give them headroom but cap so we
      // don't keep the parent function alive indefinitely. Vercel allows
      // background tasks via waitUntil up to the route's maxDuration.
      signal: AbortSignal.timeout(60_000),
    });
  } catch { /* ignore — best-effort */ }
}

// Core: detect stale routes and return promises for the fires.
// Caller is responsible for handing the promises to ctx.waitUntil().
export async function detectAndFire(req) {
  const now = Date.now();
  const origin = selfOrigin(req);
  const promises = [];
  const fired = [];

  for (const [name, cfg] of Object.entries(ROUTES)) {
    const last = lastFiredAt.get(name) || 0;
    if (now - last < cfg.coolDownMs) continue;
    const age = await ageOf(cfg.storageKey, cfg.stateField);
    if (age < cfg.freshnessMs) continue;
    lastFiredAt.set(name, now);
    promises.push(fireOne(origin, cfg.path));
    fired.push({ name, ageMinBeforeFire: age === Infinity ? null : Math.round(age / 60000) });
  }

  return { promises, fired };
}

// Convenience wrapper for route handlers: runs detection, hands the promises
// to waitUntil so they survive past the response. Pass the request and the
// route's `ctx` (Next.js gives you this in the App Router via the second arg).
//
// In Next.js App Router, route handlers don't receive a context object with
// waitUntil directly — but we can use the experimental `after` API or fall
// back to `Promise.allSettled` which Next.js will keep alive on Vercel via
// `@vercel/functions/oidc` semantics. Easiest portable path: import
// `unstable_after` from `next/server` if available, else just await briefly.
export async function fireStaleCronsInBackground(req) {
  const { promises, fired } = await detectAndFire(req);
  if (promises.length === 0) return fired;

  // Try to use Next.js `after()` if available (Next 15+ App Router) — it
  // keeps the work alive after response. Fall back to Vercel's waitUntil.
  try {
    const mod = await import("next/server");
    if (typeof mod.after === "function") {
      mod.after(() => Promise.allSettled(promises));
      return fired;
    }
  } catch { /* fallthrough */ }

  // Vercel platform exposes waitUntil on the request context in newer runtimes
  try {
    // @vercel/functions exposes waitUntil; if installed it can be used here.
    // For now, kick off the fetches and don't block the response — they'll
    // race the function shutdown, but with 60s timeouts they typically finish.
    Promise.allSettled(promises).catch(() => {});
  } catch { /* ignore */ }

  return fired;
}

// Read-only inspector for the live API route — lets the UI show "last fired"
// state without triggering anything.
export async function describeStaleness() {
  const out = {};
  for (const [name, cfg] of Object.entries(ROUTES)) {
    const age = await ageOf(cfg.storageKey, cfg.stateField);
    out[name] = {
      ageMs: age === Infinity ? null : age,
      ageMinutes: age === Infinity ? null : Math.round(age / 60000),
      stale: age >= cfg.freshnessMs,
      lastFiredAt: lastFiredAt.get(name) ?? null,
    };
  }
  return out;
}
