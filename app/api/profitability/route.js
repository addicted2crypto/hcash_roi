import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// Serves the cohort summary + facility breakdown + leaderboard JSON produced by
// `scripts/scan-profitability.mjs` / the cron route. Returned data is the
// canonical input to /profitability.

const COHORTS_PATH = path.resolve("data/profitability-cohorts.json");

export async function GET() {
  if (!fs.existsSync(COHORTS_PATH)) {
    return NextResponse.json(
      { error: "Profitability scan has not run yet — no data file", cohorts: null },
      { status: 503 }
    );
  }

  try {
    const stat = fs.statSync(COHORTS_PATH);
    const data = JSON.parse(fs.readFileSync(COHORTS_PATH, "utf8"));
    const ageMs = Date.now() - stat.mtimeMs;
    // 24h is generous — cron runs every 12h; >24h = something is wrong
    const stale = ageMs > 24 * 60 * 60 * 1000;

    return NextResponse.json({
      ...data,
      ageMs,
      stale,
      fileUpdatedAt: new Date(stat.mtimeMs).toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to read profitability data", message: String(err).slice(0, 200) },
      { status: 500 }
    );
  }
}
