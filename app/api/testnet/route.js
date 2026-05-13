import { NextResponse } from "next/server";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";

// HashCash Testnet stats from the public Mempool Explorer
// (mempool.space-style API, same endpoint paths as the upstream project).
//
// Sourced fields:
//   blockHeight             — current tip height (heartbeat — confirms chain is producing)
//   mempool.count           — pending tx in mempool
//   mempool.vsize           — pending vsize
//   difficulty.progress%    — % into current retarget window
//   difficulty.changePct    — projected next retarget change
//   difficulty.remaining    — blocks until next retarget
//
// We DON'T promise per-miner stats here — those would need the stratum pool URL
// which HC hasn't published yet for testnet. When they do, we extend this route.

const MEMPOOL_BASE = "https://mempool.hashcash-test.network/api";
const PER_REQ_TIMEOUT_MS = 5000;

// In-memory cache: 30s. Testnet block time is multi-minute, sub-30s polling
// burns Vercel function invocations without giving real freshness.
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PER_REQ_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    // tip/height returns a bare number — wrap so callers always get a JSON-ish value
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text.trim(); }
  } catch {
    return null;
  }
}

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 30, windowMs: 60_000 })) return tooManyRequests();

  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cache, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" },
    });
  }

  const [height, mempool, diff] = await Promise.all([
    fetchJson(`${MEMPOOL_BASE}/blocks/tip/height`),
    fetchJson(`${MEMPOOL_BASE}/mempool`),
    fetchJson(`${MEMPOOL_BASE}/v1/difficulty-adjustment`),
  ]);

  // If everything failed, mempool host is down — surface honestly
  if (height == null && mempool == null && diff == null) {
    const result = { live: false, error: "testnet mempool unreachable", updatedAt: new Date().toISOString() };
    return NextResponse.json(result, { status: 503 });
  }

  const result = {
    live: true,
    blockHeight: Number(height) || null,
    mempool: mempool ? {
      pending: Number(mempool.count) || 0,
      vsize: Number(mempool.vsize) || 0,
      totalFee: Number(mempool.total_fee) || 0,
    } : null,
    difficulty: diff ? {
      progressPercent: typeof diff.progressPercent === "number" ? +diff.progressPercent.toFixed(2) : null,
      changePercent: typeof diff.difficultyChange === "number" ? +diff.difficultyChange.toFixed(2) : null,
      remainingBlocks: Number(diff.remainingBlocks) || null,
      nextRetargetHeight: Number(diff.nextRetargetHeight) || null,
    } : null,
    source: "mempool.hashcash-test.network",
    updatedAt: new Date().toISOString(),
  };

  cache = result;
  cacheTime = now;
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" },
  });
}
