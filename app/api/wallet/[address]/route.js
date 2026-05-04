import { NextResponse } from "next/server";
import { isValidAddress } from "@/lib/snowtrace";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";
import { getJson, statJson, KEYS } from "@/lib/storage.js";

export async function GET(req, { params }) {
  if (!rateLimit(getClientIp(req), { maxReqs: 30, windowMs: 60_000 })) return tooManyRequests();
  const { address } = await params;
  const lower = (address || "").toLowerCase();

  if (!isValidAddress(lower)) {
    return NextResponse.json(
      { error: "Invalid address — must match 0x[40 hex]" },
      { status: 400 }
    );
  }

  const data = await getJson(KEYS.WALLET_PNL, null);
  if (!data) {
    return NextResponse.json(
      { error: "Wallet index has not been built yet — scan still running", wallet: null },
      { status: 503 }
    );
  }

  try {
    const stat = await statJson(KEYS.WALLET_PNL);
    const wallet = data[lower] || null;
    const ageMs = stat ? Date.now() - stat.mtimeMs : null;
    const stale = ageMs != null ? ageMs > 24 * 60 * 60 * 1000 : false;

    if (!wallet) {
      // 200 with empty body — wallet is shape-valid but never touched the game.
      return NextResponse.json({
        address: lower,
        found: false,
        ageMs,
        stale,
        fileUpdatedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
      });
    }

    return NextResponse.json({
      address: lower,
      found: true,
      ...wallet,
      ageMs,
      stale,
      fileUpdatedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to read wallet data", message: String(err).slice(0, 200) },
      { status: 500 }
    );
  }
}
