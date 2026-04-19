import { NextResponse } from "next/server";

const POOL_URL = "http://stratum.hcash-dev.network:3334/api/pool";

// Cache: 30 seconds (pool data changes fast but we don't need sub-minute polling)
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 1000;

export async function GET() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  try {
    const res = await fetch(POOL_URL, {
      // Short timeout — this is dev infra, may go down
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Pool unavailable", live: false },
        { status: 503 }
      );
    }

    const data = await res.json();

    // Compact response: only what we need client-side
    const uniqueMiners = data.blocksFound
      ? new Set(data.blocksFound.map((b) => b.minerAddress)).size
      : 0;

    const result = {
      live: true,
      hashRate: Math.round(data.totalHashRate || 0),
      blockHeight: data.blockHeight || 0,
      activeMiners: data.totalMiners || 0,
      uniqueMiners,
      totalBlocks: data.blocksFound?.length || 0,
      updatedAt: new Date().toISOString(),
    };

    cache = result;
    cacheTime = now;
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Pool unreachable", live: false },
      { status: 503 }
    );
  }
}
