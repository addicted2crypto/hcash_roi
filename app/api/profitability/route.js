import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";

// Serves the cohort summary + facility breakdown + leaderboard JSON produced by
// `scripts/scan-profitability.mjs` / the cron route. Returned data is the
// canonical input to /profitability.
//
// Live-delta merge: between full daily scans, the on-chain watcher accumulates
// MinerBought/FacilityBought events into data/leaderboard-delta.json. We merge
// those into the response so the home leaderboard reflects in-flight buys
// without waiting for the next 06:00 UTC scan.

const COHORTS_PATH = path.resolve("data/profitability-cohorts.json");
const DELTA_PATH   = path.resolve("data/leaderboard-delta.json");

function loadDelta() {
  if (!fs.existsSync(DELTA_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DELTA_PATH, "utf8")); } catch { return null; }
}

// Apply per-wallet deltas onto a leaderboard list. avaxIn grows by raw AVAX
// spend plus hCASH spend converted at the live ratio; netAvax/netUsd recompute.
function applyDelta(list, delta, avaxUsd, hcashAvax) {
  if (!Array.isArray(list) || !delta?.wallets) return list;
  return list.map(w => {
    const d = delta.wallets[w.addr?.toLowerCase()];
    if (!d) return w;
    const extraAvax  = Number(BigInt(d.avaxSpentWei  || "0")) / 1e18;
    const extraHcash = Number(BigInt(d.hcashSpentWei || "0")) / 1e18;
    const extraAvaxFromHcash = hcashAvax ? extraHcash * hcashAvax : 0;
    const newAvaxIn  = (w.avaxIn || 0) + extraAvax + extraAvaxFromHcash;
    const newNetAvax = (w.avaxOut || 0) + (w.paperAvax || 0) - newAvaxIn;
    return {
      ...w,
      avaxIn:  +newAvaxIn.toFixed(6),
      netAvax: +newNetAvax.toFixed(6),
      netUsd:  avaxUsd ? +(newNetAvax * avaxUsd).toFixed(2) : w.netUsd,
      _liveDelta: {
        facilityUpgrades: d.facilityUpgrades || 0,
        minerHcashBuys:   d.minerHcashBuys   || 0,
        minerAvaxBuys:    d.minerAvaxBuys    || 0,
        sinceBlock:       delta.lastBlock    || null,
      },
    };
  });
}

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

    // Merge live deltas if present
    const delta = loadDelta();
    const hcashAvax = hcashUsdSpot && avaxUsd ? hcashUsdSpot / avaxUsd : null;
    const liveLeaderboardTop    = delta ? applyDelta(leaderboardTop,    delta, avaxUsd, hcashAvax) : leaderboardTop;
    const liveLeaderboardBottom = delta ? applyDelta(leaderboardBottom, delta, avaxUsd, hcashAvax) : leaderboardBottom;

    return NextResponse.json({
      cohortCounts, operationalCohorts, byFacility,
      leaderboardTop: liveLeaderboardTop,
      leaderboardBottom: liveLeaderboardBottom,
      topHcashHolders, topHashrateOwners,
      network, walletsTotal, scanBlock, scannedAt,
      avaxUsd, hcashUsdSpot, sources,
      ageMs, stale,
      liveDelta: delta ? {
        lastBlock: delta.lastBlock,
        lastUpdated: delta.lastUpdated,
        eventCount: delta.eventCount,
        walletsAffected: Object.keys(delta.wallets || {}).length,
      } : null,
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
