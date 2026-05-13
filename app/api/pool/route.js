import { NextResponse } from "next/server";

// LEGACY: The original stratum.hcash-dev.network endpoint is deprecated as of
// the HashCash Testnet launch (May 7 2026). HC moved to hashcash-test.network.
// This route now returns `live: false` immediately so the dashboard's pool
// ticker hides cleanly. Live testnet stats are served by /api/testnet instead.

export async function GET() {
  return NextResponse.json({ live: false, deprecated: true }, { status: 200 });
}
