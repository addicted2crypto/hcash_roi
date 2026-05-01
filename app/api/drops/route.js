import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";

const DROPS_PATH = path.resolve("data/new-drops.json");

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 30, windowMs: 60_000 })) return tooManyRequests();

  if (!fs.existsSync(DROPS_PATH)) {
    // No drops file yet — registry cron hasn't run. Return empty, not an error.
    return NextResponse.json({ drops: [], updatedAt: null }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" },
    });
  }

  try {
    const stat = fs.statSync(DROPS_PATH);
    const raw = JSON.parse(fs.readFileSync(DROPS_PATH, "utf8"));
    return NextResponse.json({
      drops: raw.drops || [],
      updatedAt: raw.updatedAt || null,
      fileUpdatedAt: new Date(stat.mtimeMs).toISOString(),
    }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to read drops data", drops: [] },
      { status: 500 }
    );
  }
}
