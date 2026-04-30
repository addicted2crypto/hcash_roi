import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";

// Serves the cohort summary + facility breakdown + leaderboard JSON produced by
// `scripts/scan-profitability.mjs` / the cron route. Returned data is the
// canonical input to /profitability.

const COHORTS_PATH = path.resolve("data/profitability-cohorts.json");

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 30, windowMs: 60_000 })) return tooManyRequests();

  if (!fs.existsSync(COHORTS_PATH)) {
    return NextResponse.json(
      { error: "Profitability scan has not run yet — no data file", cohorts: null },
      { status: 503 }
    );
  }

  try {
    const stat = fs.statSync(COHORTS_PATH);
    const raw = JSON.parse(fs.readFileSync(COHORTS_PATH, "utf8"));
    const ageMs = Date.now() - stat.mtimeMs;
    const stale = ageMs > 24 * 60 * 60 * 1000;

    // Explicit allowlist — never spread raw file contents into the response.
    // Internal fields (_validation, durationSec, scanFromBlock, etc.) stay server-side.
    const {
      cohortCounts, operationalCohorts, byFacility,
      leaderboardTop, leaderboardBottom,
      topHcashHolders, topHashrateOwners,
      network, walletsTotal, scanBlock, scannedAt,
      avaxUsd, hcashUsdSpot, sources,
    } = raw;

    return NextResponse.json({
      cohortCounts, operationalCohorts, byFacility,
      leaderboardTop, leaderboardBottom,
      topHcashHolders, topHashrateOwners,
      network, walletsTotal, scanBlock, scannedAt,
      avaxUsd, hcashUsdSpot, sources,
      ageMs, stale,
    }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to read profitability data", message: String(err).slice(0, 200) },
      { status: 500 }
    );
  }
}
