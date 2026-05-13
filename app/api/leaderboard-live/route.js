import { NextResponse } from "next/server";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";
import { getLiveLeaderboard } from "@/lib/leaderboard-live.js";

// Live top-50 leaderboard overlay.
//
// Reads the top-50 wallet addresses from the cohort scan snapshot (refreshed
// every ~8 hours), then does live RPC reads for each to recompute Net P&L
// with current chain state + current spot prices.
//
// Caching strategy:
//   - In-memory SWR for 60s — 50 concurrent visits share a single scrape
//   - Vercel CDN cache for 60s — same payload across all edge nodes
// Net result: ~5s of RPC work per minute regardless of visit volume.

export const dynamic = "force-dynamic";

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;
let inflight = null; // dedupe concurrent regenerations within a single instance

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 30, windowMs: 60_000 })) return tooManyRequests();

  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cache, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" },
    });
  }

  // Dedupe: if another request triggered a fetch while this one was waiting,
  // join the same promise instead of starting a duplicate scrape.
  if (!inflight) {
    inflight = getLiveLeaderboard({ limit: 50 }).then(result => {
      cache = result;
      cacheTime = Date.now();
      return result;
    }).catch(err => {
      inflight = null;
      throw err;
    }).finally(() => {
      inflight = null;
    });
  }

  try {
    const result = await inflight;
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" },
    });
  } catch (err) {
    // Failure path: serve last-good cache if available, else surface the error
    if (cache) {
      return NextResponse.json({ ...cache, stale: true, error: String(err).slice(0, 200) }, {
        headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" },
      });
    }
    return NextResponse.json(
      { ok: false, error: "Live leaderboard read failed", message: String(err).slice(0, 200) },
      { status: 503 }
    );
  }
}
