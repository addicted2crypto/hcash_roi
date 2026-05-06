import { SNOWTRACE, CONTRACTS, truncAddr, isValidAddress } from "@/lib/snowtrace";
import { getJson, statJson, KEYS } from "@/lib/storage.js";
import { withFailover } from "@/lib/rpc-failover.js";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import Link from "next/link";

// Was previously `revalidate = 600`. Now reads from Blob via storage layer
// (with built-in 60s in-memory cache) on each request. No stale HTML cache.
export const dynamic = "force-dynamic";

// Live RPC reads — server-side only, never exposed to client.
// Reads current hCASH balance, hashrate, and emission rate at the moment of
// request. The displayed Net P&L uses these LIVE values + spot prices, not
// the cohort scan snapshot. Snapshot stays as the underlying cohort tag and
// historical AVAX flows (immutable). The drift between live balance and
// snapshot balance is what makes the dashboard genuinely live.
const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const HCASH_TOKEN = "0xba5444409257967e5e50b113c395a766b0678c03";
const CL_AVAX_USD = "0x0A77230d17318075983913bC2145DB16C7366156";

// In-memory cache of live reads, keyed by address. 60s TTL — enough to absorb
// page-load bursts, fresh enough that the user-visible drift is sub-minute.
const liveCache = new Map();
const LIVE_TTL_MS = 60_000;

async function readLiveWalletState(addr) {
  const cached = liveCache.get(addr);
  if (cached && Date.now() - cached.fetchedAt < LIVE_TTL_MS) return cached.data;

  // Bundled ABI cache — avoids re-fetching ABIs from HC API
  let gameAbi = null;
  try {
    const p = path.resolve("data/abi-cache/main.v1.json");
    if (fs.existsSync(p)) gameAbi = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { /* fall through */ }

  // Minimal ABI for what we need — keeps the call cheap if game ABI missing
  const fallbackAbi = [
    "function playerHashrate(address) view returns (uint256)",
    "function playerBigcoinPerBlock(address) view returns (uint256)",
    "function ownerToFacility(address) view returns (uint256 facilityIndex, uint256 currPowerOutput, uint256 electricityCost, uint256 lastClaim)",
  ];
  const erc20Abi = ["function balanceOf(address) view returns (uint256)"];

  try {
    const live = await withFailover(async (provider) => {
      const game = new ethers.Contract(GAME_MAIN, gameAbi || fallbackAbi, provider);
      const hcash = new ethers.Contract(HCASH_TOKEN, erc20Abi, provider);
      // Chainlink AVAX/USD aggregator — single low-level call
      const clAvax = await provider.call({ to: CL_AVAX_USD, data: "0xfeaf968c" }); // latestRoundData()

      const [balRaw, hashrateRaw, emissionRaw, otf] = await Promise.all([
        hcash.balanceOf(addr),
        game.playerHashrate(addr),
        game.playerBigcoinPerBlock(addr),
        game.ownerToFacility(addr),
      ]);

      let avaxUsd = null;
      if (clAvax && clAvax.length >= 130) {
        const v = parseInt(clAvax.slice(66, 130), 16);
        if (v > 0 && v < 1e13) avaxUsd = v / 1e8;
      }

      return {
        hcashBalance: Number(balRaw) / 1e18,
        hashrate: Number(hashrateRaw),
        emissionPerBlock: Number(emissionRaw) / 1e18,
        facilityIndex: Number(otf.facilityIndex),
        avaxUsd,
      };
    }, { label: `wallet-live[${addr}]`, timeoutMs: 4000 });

    liveCache.set(addr, { data: live, fetchedAt: Date.now() });
    return live;
  } catch {
    return null; // gracefully degrade — page falls back to snapshot only
  }
}

// hCASH/AVAX spot from DexScreener — public, no key
async function readHcashAvaxSpot() {
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

export async function generateMetadata({ params }) {
  const { address } = await params;
  const lower = (address || "").toLowerCase();
  if (!isValidAddress(lower)) {
    return { title: "Invalid wallet — hCASH ROI Oracle" };
  }
  return {
    title: `${truncAddr(lower)} · hCASH P&L — hCASH ROI Oracle`,
    description: `On-chain P&L for ${truncAddr(lower)}: AVAX spent vs received, hCASH held, cohort status. All numbers verifiable on Snowtrace.`,
  };
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

async function getWallet(addr) {
  const data = await getJson(KEYS.WALLET_PNL, null);
  if (!data) return { fileMissing: true };
  const stat = await statJson(KEYS.WALLET_PNL);
  const w = data[addr] || null;
  return {
    wallet: w,
    ageMs: stat ? Date.now() - stat.mtimeMs : null,
    fileUpdatedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
  };
}

export default async function WalletPage({ params }) {
  const { address } = await params;
  const lower = (address || "").toLowerCase();
  if (!isValidAddress(lower)) notFound();

  const { wallet, fileMissing, ageMs, fileUpdatedAt } = await getWallet(lower);
  const stale = ageMs && ageMs > 24 * 60 * 60 * 1000;

  // Live RPC overlay — runs server-side only. If the wallet exists in our
  // snapshot, fetch its CURRENT chain state and overwrite the displayed
  // balance/hashrate/emission/Net P&L with truth-as-of-now.
  let live = null;
  let livePaperAvax = null;
  let liveNetAvax = null;
  let liveNetUsd = null;
  let liveDailyEmissionHcash = null;
  let liveDailyElecHcash = null;
  let liveNetHcashDay = null;
  if (wallet) {
    const [liveData, hcashAvaxSpot] = await Promise.all([
      readLiveWalletState(lower),
      readHcashAvaxSpot(),
    ]);
    if (liveData) {
      live = { ...liveData, hcashAvaxSpot };
      // Recompute paper P&L with current balance × current spot
      if (hcashAvaxSpot != null) {
        livePaperAvax = liveData.hcashBalance * hcashAvaxSpot;
        // Net AVAX = realized AVAX out + current paper - historical AVAX in
        liveNetAvax = (wallet.avaxOut || 0) + livePaperAvax - (wallet.avaxIn || 0);
        if (liveData.avaxUsd != null) {
          liveNetUsd = liveNetAvax * liveData.avaxUsd;
        }
      }
      // Operational daily emission — derived from current emission rate
      // Conservative: assume same blocks/day as the snapshot used (~83802)
      const blocksPerDay = 83802;
      liveDailyEmissionHcash = liveData.emissionPerBlock * blocksPerDay;
      // Electricity cost is from the snapshot — facility upgrades are infrequent
      // so the snapshot's electricity figure is usually still valid
      liveDailyElecHcash = wallet.dailyElecHcash || 0;
      liveNetHcashDay = liveDailyEmissionHcash - liveDailyElecHcash;
    }
  }

  if (fileMissing) {
    return (
      <PageShell address={lower}>
        <div className="rounded-2xl border border-amber-400/20 p-8 text-center" style={{ background: "rgba(245,158,11,0.04)" }}>
          <div className="text-[10px] tracking-[0.3em] text-amber-400/60 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            FIRST SCAN IN PROGRESS
          </div>
          <p className="text-white/60">
            Per-wallet data hasn't been built yet. Reload in a few minutes.
          </p>
        </div>
      </PageShell>
    );
  }

  if (!wallet) {
    return (
      <PageShell address={lower}>
        <div className="rounded-2xl border border-white/10 p-8 text-center">
          <div className="text-[10px] tracking-[0.3em] text-white/40 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            NO ACTIVITY
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">{truncAddr(lower, 8, 6)}</h2>
          <p className="text-white/40 max-w-md mx-auto mb-6">
            This wallet has not entered the hCASH game. No InitialFacilityPurchased event, no miner buys.
          </p>
          <Link href="/profitability" className="inline-block px-4 py-2 rounded-lg bg-cyan-500/15 text-cyan-400 text-sm hover:bg-cyan-500/25 transition-colors"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            See the leaderboard →
          </Link>
        </div>
      </PageShell>
    );
  }

  const cohortMeta = {
    realized_profit: { label: "REALIZED PROFIT", color: "emerald", bg: "rgba(34,197,94,0.06)", border: "rgba(34,197,94,0.25)" },
    paper_profit:    { label: "PAPER PROFIT",    color: "amber",   bg: "rgba(245,158,11,0.07)", border: "rgba(245,158,11,0.25)" },
    underwater:      { label: "UNDERWATER",      color: "red",     bg: "rgba(239,68,68,0.07)",  border: "rgba(239,68,68,0.25)" },
  }[wallet.cohort];

  // Prefer LIVE values when available, fall back to snapshot
  const displayNetUsd = liveNetUsd != null ? liveNetUsd : wallet.netUsd;
  const displayNetAvax = liveNetAvax != null ? liveNetAvax : wallet.netAvax;
  const displayHcashBalance = live?.hcashBalance != null ? live.hcashBalance : wallet.hcashBalance;
  const displayPaperAvax = livePaperAvax != null ? livePaperAvax : wallet.paperAvax;
  const displayHashrate = live?.hashrate != null ? live.hashrate : wallet.hashrate;
  const displayDailyEmissionHcash = liveDailyEmissionHcash != null ? liveDailyEmissionHcash : wallet.dailyEmissionHcash;
  const displayNetHcashDay = liveNetHcashDay != null ? liveNetHcashDay : wallet.netHcashDay;
  const isLive = live != null;

  const positive = displayNetUsd > 0;
  const numColor = positive ? "text-emerald-400" : "text-red-400";

  return (
    <PageShell address={lower}>
      {/* ─── SCREENSHOT-WORTHY HERO ─── */}
      <div className="rounded-2xl p-8 md:p-10 mb-6"
           style={{ background: cohortMeta?.bg || "rgba(255,255,255,0.02)", border: `1px solid ${cohortMeta?.border || "rgba(255,255,255,0.08)"}` }}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <code className="text-white/50 text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {truncAddr(lower, 8, 6)}
            </code>
            <span className={`text-[10px] tracking-[0.3em] px-2 py-1 rounded text-${cohortMeta.color}-400`}
                  style={{ fontFamily: "'JetBrains Mono', monospace", background: cohortMeta.bg, border: `1px solid ${cohortMeta.border}` }}>
              {cohortMeta.label}
            </span>
            {isLive && (
              <span className="text-[10px] tracking-[0.3em] text-emerald-400/90 px-2 py-1 rounded" style={{ fontFamily: "'JetBrains Mono', monospace", background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)" }}>
                ● LIVE
              </span>
            )}
            {!isLive && stale && (
              <span className="text-[10px] tracking-[0.3em] text-amber-400/70" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                · STALE
              </span>
            )}
          </div>
          <a href={SNOWTRACE.contract(lower)} target="_blank" rel="noopener noreferrer"
             className="text-[10px] text-white/30 hover:text-cyan-400 tracking-wider transition-colors"
             style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            view on snowtrace ↗
          </a>
        </div>

        <div className={`text-6xl md:text-7xl font-extrabold tabular-nums ${numColor} mb-2`}
             style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {positive ? "+" : ""}${Math.abs(displayNetUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </div>
        <div className="text-white/40 text-sm mb-1">
          Net P&amp;L {isLive ? "· live read" : "· snapshot from last scan"}
        </div>
        <div className="text-white/30 text-xs mb-6" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {isLive ? (
            <>
              hCASH balance + emission rate read direct from chain at this request.{" "}
              Cohort tag + historical AVAX flows from {fileUpdatedAt && <>last scan <span className="text-white/45">{fmtAgo(fileUpdatedAt)}</span></>} ·{" "}
              <a href={SNOWTRACE.contract(lower)} target="_blank" rel="noopener noreferrer"
                 className="text-cyan-400/70 hover:text-cyan-400 transition-colors">
                verify on Snowtrace ↗
              </a>
            </>
          ) : (
            <>
              {fileUpdatedAt && (
                <>scanned <span className={stale ? "text-amber-400/80" : "text-white/45"}>{fmtAgo(fileUpdatedAt)}</span> · </>
              )}
              hCASH balance and emission may have moved since ·{" "}
              <a href={SNOWTRACE.contract(lower)} target="_blank" rel="noopener noreferrer"
                 className="text-cyan-400/70 hover:text-cyan-400 transition-colors">
                verify live on Snowtrace ↗
              </a>
            </>
          )}
        </div>

        {/* Stat tiles — live values when available */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatTile label="AVAX SPENT"    value={`${wallet.avaxIn.toFixed(2)}`}    sub="AVAX in (historical)"  />
          <StatTile label="AVAX EARNED"   value={`${wallet.avaxOut.toFixed(2)}`}   sub="AVAX out (historical)" />
          <StatTile
            label={isLive ? "hCASH HELD · LIVE" : "hCASH HELD"}
            value={displayHcashBalance.toLocaleString(undefined,{maximumFractionDigits:0})}
            sub={`worth ${displayPaperAvax.toFixed(2)} AVAX`}
          />
        </div>

        {/* Concentration pills — % of supply, % of network hashrate */}
        {(wallet.pctOfSupply > 0 || wallet.pctOfNetwork > 0) && (
          <div className="mt-4 flex flex-wrap gap-2 text-[10px] tracking-wider" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {wallet.pctOfSupply > 0 && (
              <span className="px-2 py-1 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20">
                {wallet.pctOfSupply.toFixed(3)}% OF SUPPLY
              </span>
            )}
            {wallet.pctOfNetwork > 0 && (
              <span className="px-2 py-1 rounded bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">
                {wallet.pctOfNetwork.toFixed(3)}% OF NETWORK HASHRATE
              </span>
            )}
          </div>
        )}

        {/* Verify-on-chain row — small pills, doesn't compete with the big number */}
        <div className="mt-5 flex flex-wrap gap-3 text-[10px] tracking-wider"
             style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          <span className="text-white/30">VERIFY ON-CHAIN:</span>
          <a href={SNOWTRACE.tokenTransfers(CONTRACTS.HCASH_TOKEN, lower)}
             target="_blank" rel="noopener noreferrer"
             className="text-white/40 hover:text-cyan-400 transition-colors">hCASH transfers ↗</a>
          <a href={SNOWTRACE.read(CONTRACTS.HCASH_TOKEN, "balanceOf")}
             target="_blank" rel="noopener noreferrer"
             className="text-white/40 hover:text-cyan-400 transition-colors">balanceOf ↗</a>
          <a href={SNOWTRACE.read(CONTRACTS.GAME_MAIN, "ownerToFacility")}
             target="_blank" rel="noopener noreferrer"
             className="text-white/40 hover:text-cyan-400 transition-colors">ownerToFacility ↗</a>
          <a href={SNOWTRACE.read(CONTRACTS.GAME_MAIN, "playerBigcoinPerBlock")}
             target="_blank" rel="noopener noreferrer"
             className="text-white/40 hover:text-cyan-400 transition-colors">playerBigcoinPerBlock ↗</a>
        </div>
      </div>

      {/* ─── BREAKDOWN ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="rounded-xl border border-white/5 p-5">
          <div className="text-[10px] tracking-[0.3em] text-white/40 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            COST BASIS · IN
          </div>
          <Row label="Initial entries"           value={`${wallet._proof?.entries ?? 0} × 2 AVAX`} />
          <Row label="Miner AVAX buys"           value={`${wallet._proof?.minerAvaxBuys ?? 0} txs`} />
          <Row label="Marketplace AVAX/USDC buys" value={`${wallet._proof?.marketBuys ?? 0} txs`} />
          <Row label="Total spent"               value={`${wallet.avaxIn.toFixed(4)} AVAX`} highlight />
        </div>
        <div className="rounded-xl border border-white/5 p-5">
          <div className="text-[10px] tracking-[0.3em] text-white/40 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            REALIZED + PAPER · OUT
          </div>
          <Row label="DEX hCASH→AVAX sells"      value={`${wallet._proof?.dexSells ?? 0} txs`} />
          <Row label="Marketplace AVAX/USDC sells" value={`${wallet._proof?.marketSells ?? 0} txs`} />
          <Row label="Held hCASH (paper AVAX)"   value={`${wallet.paperAvax.toFixed(4)} AVAX`} />
          <Row label="Total out + paper"         value={`${(wallet.avaxOut + wallet.paperAvax).toFixed(4)} AVAX`} highlight />
        </div>
      </div>

      {/* ─── OPERATIONAL — Metric A (live emission rate when available) ─── */}
      {wallet.facilityLevel !== null && (
        <div className="rounded-xl border border-white/5 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] tracking-[0.3em] text-white/40 flex items-center gap-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              OPERATIONAL · AT CURRENT BLOCK
              {isLive && <span className="text-emerald-400/80">● LIVE</span>}
            </div>
            <div className="text-[10px] text-white/30 tracking-wider" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              Lv.{wallet.facilityLevel} · {displayHashrate.toLocaleString()} MH/s
            </div>
          </div>
          <Row label="Daily emission share" value={`+${displayDailyEmissionHcash.toFixed(2)} hCASH`} />
          <Row label="Daily electricity"    value={`-${(wallet.dailyElecHcash || 0).toFixed(2)} hCASH`} />
          <Row label="Net hCASH/day"
               value={`${displayNetHcashDay > 0 ? "+" : ""}${displayNetHcashDay.toFixed(2)} hCASH`}
               highlight />
          <div className="mt-3 text-[10px] text-white/30" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            Status: <span className={
              (isLive ? (displayNetHcashDay > 0.01 ? "profitable" : displayNetHcashDay < -0.01 ? "underwater" : "breakeven") : wallet.operationalStatus) === "profitable" ? "text-emerald-400" :
              (isLive ? (displayNetHcashDay > 0.01 ? "profitable" : displayNetHcashDay < -0.01 ? "underwater" : "breakeven") : wallet.operationalStatus) === "underwater" ? "text-red-400" : "text-white/50"
            }>{(isLive ? (displayNetHcashDay > 0.01 ? "PROFITABLE" : displayNetHcashDay < -0.01 ? "UNDERWATER" : "BREAKEVEN") : (wallet.operationalStatus || "—").toUpperCase())}</span>
          </div>
        </div>
      )}

      {/* ─── BACK TO LEADERBOARD ─── */}
      <div className="text-center mt-12">
        <Link href="/profitability" className="text-cyan-400/70 hover:text-cyan-400 text-sm tracking-wider"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          ← back to leaderboard
        </Link>
      </div>
    </PageShell>
  );
}

function PageShell({ children, address }) {
  return (
    <div className="min-h-screen pt-12 pb-24 px-6 bg-[#06080e] text-white">
      <div className="ctr max-w-3xl mx-auto">
        <div className="text-[10px] tracking-[0.3em] text-white/30 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          WALLET / {address ? truncAddr(address, 6, 4) : "—"}
        </div>
        {children}
      </div>
    </div>
  );
}

function StatTile({ label, value, sub }) {
  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <div className="text-[9px] tracking-wider text-white/30 mb-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        {label}
      </div>
      <div className="text-xl font-bold text-white tabular-nums" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      <div className="text-[10px] text-white/30 mt-1">{sub}</div>
    </div>
  );
}

function Row({ label, value, highlight }) {
  return (
    <div className={`flex items-center justify-between py-1.5 text-sm ${highlight ? "border-t border-white/5 mt-2 pt-3" : ""}`}>
      <span className={highlight ? "text-white/70" : "text-white/40"}>{label}</span>
      <span className={`tabular-nums ${highlight ? "text-white font-bold" : "text-white/70"}`}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
    </div>
  );
}
