import { NextResponse } from "next/server";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";
import { getJson, statJson, KEYS } from "@/lib/storage.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 30, windowMs: 60_000 })) return tooManyRequests();

  const raw = await getJson(KEYS.NEW_DROPS, null);
  if (!raw) {
    return NextResponse.json({ drops: [], updatedAt: null }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" },
    });
  }

  try {
    const stat = await statJson(KEYS.NEW_DROPS);
    return NextResponse.json({
      drops: raw.drops || [],
      updatedAt: raw.updatedAt || null,
      fileUpdatedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
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
