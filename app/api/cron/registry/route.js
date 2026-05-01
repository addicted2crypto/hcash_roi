import { NextResponse } from "next/server";
import { checkRegistry } from "@/lib/registry-monitor.js";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(req) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = auth.startsWith("Bearer ") ? auth.slice(7) : auth;

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await checkRegistry();
    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      totalContracts: result.totalContracts,
      newDrops: result.newDrops.length,
      firstRun: result.firstRun ?? false,
      drops: result.newDrops,
    });
  } catch (err) {
    console.error("[cron/registry] check failed:", err);
    return NextResponse.json(
      { ok: false, error: String(err).slice(0, 300) },
      { status: 500 }
    );
  }
}
