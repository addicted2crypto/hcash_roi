import { NextResponse } from "next/server";
import { runScan } from "@/lib/profitability-scan.js";

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically.
// Set CRON_SECRET in Vercel environment variables — never commit it.
//
// Pro plan allows up to 300s; the incremental scan (new blocks only) typically
// completes well within that. Full historical scans must be run via the CLI script.

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = auth.startsWith("Bearer ") ? auth.slice(7) : auth;

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await runScan({ saveEvery: 3 });
    return NextResponse.json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      walletsTotal: result.walletsTotal,
      scanBlock: result.scanBlock,
      scannedAt: result.scannedAt,
    });
  } catch (err) {
    console.error("[cron/profitability] scan failed:", err);
    return NextResponse.json(
      { ok: false, startedAt, error: String(err).slice(0, 300) },
      { status: 500 }
    );
  }
}
