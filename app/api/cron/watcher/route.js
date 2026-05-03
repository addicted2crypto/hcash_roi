import { NextResponse } from "next/server";
import { runWatcher } from "@/lib/onchain-watcher.js";
import { runScan } from "@/lib/profitability-scan.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Cron schedule is every 5 min from vercel.json. The watcher itself decides
// whether the next interval should be tighter via its `cadenceMin` field —
// we surface it but Vercel can't dynamically reschedule, so the 5-min cadence
// is the floor. If we need 1-min cadence, change the cron to "* * * * *" and
// let the watcher's quiet-detection skip work on idle ticks.
//
// triggerRescan: if a flood of facility upgrades hit (>=25 in a single 5-min
// window) we re-run the full profitability scan immediately rather than
// waiting until 06:00 UTC. Bounded by maxDuration.

export async function GET(req) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await runWatcher();

    let rescanResult = null;
    if (result.triggerRescan) {
      try {
        const scan = await runScan({ saveEvery: 3 });
        rescanResult = { ok: true, walletsTotal: scan.walletsTotal, scanBlock: scan.scanBlock };
      } catch (err) {
        rescanResult = { ok: false, error: String(err).slice(0, 200) };
      }
    }

    return NextResponse.json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      fromBlock: result.fromBlock,
      toBlock: result.toBlock,
      eventCount: result.eventCount,
      facilityUpgrades: result.facilityUpgrades,
      costChangeCount: result.costChanges.length,
      costChanges: result.costChanges,
      launchingCount: result.launching.length,
      cadenceMin: result.cadenceMin,
      triggeredRescan: !!rescanResult,
      rescanResult,
    });
  } catch (err) {
    console.error("[cron/watcher] failed:", err);
    return NextResponse.json(
      { ok: false, startedAt, error: String(err).slice(0, 300) },
      { status: 500 }
    );
  }
}
