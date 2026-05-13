// Live leaderboard overlay — reads the top-N wallets from the cohort scan,
// runs current chain reads for each (hashrate, hCASH balance, emission rate),
// recomputes Net P&L with live spot prices.
//
// Result: the leaderboard's per-wallet numbers stay current within ~60s even
// though the cohort scan only runs every ~8 hours via GHA.
//
// Keep snapshot rank order — we don't re-rank because rankings shifting on
// every page load creates a confusing UX. Numbers update live, positions
// reflect the last cohort scan.

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { withFailover } from "./rpc-failover.js";

const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const HCASH_TOKEN = "0xba5444409257967e5e50b113c395a766b0678c03";
const CL_AVAX_USD = "0x0A77230d17318075983913bC2145DB16C7366156";

const READ_BATCH = 12;
const PER_REQ_TIMEOUT_MS = 6000;

// Minimal ABI — only what's needed, avoids round-trip to fetch the full ABI
const GAME_ABI_MIN = [
  "function playerHashrate(address) view returns (uint256)",
  "function playerBigcoinPerBlock(address) view returns (uint256)",
];
const ERC20_ABI_MIN = ["function balanceOf(address) view returns (uint256)"];

async function fetchHcashAvaxSpot() {
  // DexScreener — public, no key. Returns hCASH/AVAX native ratio.
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=hCASH",
      { signal: AbortSignal.timeout(4000), cache: "no-store" });
    const d = await r.json();
    const p = (d.pairs || []).find(pp =>
      pp.chainId === "avalanche" && pp.baseToken?.symbol?.toUpperCase() === "HCASH"
    );
    return p ? parseFloat(p.priceNative) : null;
  } catch { return null; }
}

async function fetchAvaxUsd() {
  try {
    return await withFailover(async (provider) => {
      const res = await provider.call({ to: CL_AVAX_USD, data: "0xfeaf968c" });
      if (!res || res.length < 130) return null;
      const v = parseInt(res.slice(66, 130), 16);
      return v > 0 && v < 1e13 ? v / 1e8 : null;
    }, { label: "avaxUsd", timeoutMs: 4000 });
  } catch { return null; }
}

// Read top-N wallets from the cohort scan output. Returns flat array of
// { addr, baseline } where baseline is the snapshot record we'll overlay live data onto.
function loadTopWallets(limit = 50) {
  const cohortsPath = path.resolve("data/profitability-cohorts.json");
  if (!fs.existsSync(cohortsPath)) return [];
  try {
    const cohorts = JSON.parse(fs.readFileSync(cohortsPath, "utf8"));
    const top = (cohorts.leaderboardTop || []).slice(0, limit);
    return top.map(w => ({ addr: w.addr, baseline: w }));
  } catch { return []; }
}

// Run live RPC reads for an array of addresses, in batches, via failover.
// Returns Map<addr, { hashrate, hcashBalance, emissionPerBlock }>.
async function batchReadWallets(addrs) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += READ_BATCH) {
    const slice = addrs.slice(i, i + READ_BATCH);
    try {
      const results = await withFailover(async (provider) => {
        const game = new ethers.Contract(GAME_MAIN, GAME_ABI_MIN, provider);
        const hcash = new ethers.Contract(HCASH_TOKEN, ERC20_ABI_MIN, provider);
        return Promise.all(slice.map(async (addr) => {
          try {
            const [hr, em, bal] = await Promise.all([
              game.playerHashrate(addr),
              game.playerBigcoinPerBlock(addr),
              hcash.balanceOf(addr),
            ]);
            return {
              addr,
              hashrate: Number(hr),
              emissionPerBlock: Number(em) / 1e18,
              hcashBalance: Number(bal) / 1e18,
            };
          } catch { return null; }
        }));
      }, { label: `lblive[${i}]`, timeoutMs: PER_REQ_TIMEOUT_MS });
      for (const r of results) if (r) out.set(r.addr, r);
    } catch { /* batch failed, downstream renders baseline as fallback */ }
  }
  return out;
}

// Public entry: returns array of merged baseline + live records for top-N wallets.
// Each record has both `baseline.*` (from scan) and `live.*` (from chain right now)
// plus recomputed `netAvax` / `netUsd` / `paperAvax` using current spot prices.
//
// Caller is responsible for caching — this function always does live RPC reads.
export async function getLiveLeaderboard({ limit = 50, blocksPerDay = 83802 } = {}) {
  const wallets = loadTopWallets(limit);
  if (wallets.length === 0) {
    return { ok: false, reason: "no cohort snapshot available", wallets: [] };
  }

  const addrs = wallets.map(w => w.addr);
  const [liveMap, hcashAvaxSpot, avaxUsd] = await Promise.all([
    batchReadWallets(addrs),
    fetchHcashAvaxSpot(),
    fetchAvaxUsd(),
  ]);

  const merged = wallets.map(({ addr, baseline }) => {
    const live = liveMap.get(addr) || null;
    if (!live || hcashAvaxSpot == null || avaxUsd == null) {
      // Fall back to snapshot record — surface that this row is NOT live
      return {
        addr,
        snapshotRank: baseline,
        live: null,
        liveReadFailed: true,
      };
    }

    // Recompute paper AVAX from live balance × live spot
    const paperAvax = live.hcashBalance * hcashAvaxSpot;
    // Net AVAX = realized AVAX out (snapshot, immutable) + live paper - realized AVAX in (snapshot, immutable)
    const netAvax = (baseline.avaxOut || 0) + paperAvax - (baseline.avaxIn || 0);
    const netUsd = netAvax * avaxUsd;
    const dailyEmissionHcash = live.emissionPerBlock * blocksPerDay;
    // Electricity is from snapshot — facility upgrades are infrequent, snapshot value still valid
    const dailyElecHcash = baseline.dailyElecHcash || 0;
    const netHcashDay = dailyEmissionHcash - dailyElecHcash;

    return {
      addr,
      snapshotRank: baseline,
      live: {
        hashrate: live.hashrate,
        hcashBalance: +live.hcashBalance.toFixed(4),
        emissionPerBlock: live.emissionPerBlock,
        paperAvax: +paperAvax.toFixed(6),
        netAvax: +netAvax.toFixed(6),
        netUsd: +netUsd.toFixed(2),
        dailyEmissionHcash: +dailyEmissionHcash.toFixed(2),
        dailyElecHcash: +dailyElecHcash.toFixed(2),
        netHcashDay: +netHcashDay.toFixed(2),
      },
      liveReadFailed: false,
    };
  });

  return {
    ok: true,
    walletsRead: liveMap.size,
    walletsRequested: addrs.length,
    avaxUsd,
    hcashAvaxSpot,
    hcashUsd: hcashAvaxSpot != null && avaxUsd != null ? +(hcashAvaxSpot * avaxUsd).toFixed(6) : null,
    fetchedAt: new Date().toISOString(),
    wallets: merged,
  };
}
