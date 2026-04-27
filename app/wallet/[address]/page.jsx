import { SNOWTRACE, CONTRACTS, truncAddr, isValidAddress } from "@/lib/snowtrace";
import { notFound } from "next/navigation";
import Link from "next/link";

export const revalidate = 600;

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

async function getWallet(addr) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const p = path.resolve("data/wallet-pnl.json");
  if (!fs.existsSync(p)) return { fileMissing: true };
  try {
    const stat = fs.statSync(p);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const w = data[addr] || null;
    return { wallet: w, ageMs: Date.now() - stat.mtimeMs, fileUpdatedAt: new Date(stat.mtimeMs).toISOString() };
  } catch { return { error: true }; }
}

export default async function WalletPage({ params }) {
  const { address } = await params;
  const lower = (address || "").toLowerCase();
  if (!isValidAddress(lower)) notFound();

  const { wallet, fileMissing, ageMs } = await getWallet(lower);
  const stale = ageMs && ageMs > 24 * 60 * 60 * 1000;

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

  const positive = wallet.netUsd > 0;
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
            {stale && (
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
          {positive ? "+" : ""}${Math.abs(wallet.netUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </div>
        <div className="text-white/40 text-sm mb-6">Net P&amp;L · all-time on-chain</div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatTile label="AVAX SPENT"    value={`${wallet.avaxIn.toFixed(2)}`}    sub="AVAX in"  />
          <StatTile label="AVAX EARNED"   value={`${wallet.avaxOut.toFixed(2)}`}   sub="AVAX out" />
          <StatTile label="hCASH HELD"    value={wallet.hcashBalance.toLocaleString(undefined,{maximumFractionDigits:0})} sub={`worth ${wallet.paperAvax.toFixed(2)} AVAX`} />
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

      {/* ─── OPERATIONAL — Metric A ─── */}
      {wallet.facilityLevel !== null && (
        <div className="rounded-xl border border-white/5 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] tracking-[0.3em] text-white/40" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              OPERATIONAL · AT CURRENT BLOCK
            </div>
            <div className="text-[10px] text-white/30 tracking-wider" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              Lv.{wallet.facilityLevel} · {wallet.hashrate} MH/s
            </div>
          </div>
          <Row label="Daily emission share" value={`+${wallet.dailyEmissionHcash.toFixed(2)} hCASH`} />
          <Row label="Daily electricity"    value={`-${wallet.dailyElecHcash.toFixed(2)} hCASH`} />
          <Row label="Net hCASH/day"
               value={`${wallet.netHcashDay > 0 ? "+" : ""}${wallet.netHcashDay.toFixed(2)} hCASH`}
               highlight />
          <div className="mt-3 text-[10px] text-white/30" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            Status: <span className={
              wallet.operationalStatus === "profitable" ? "text-emerald-400" :
              wallet.operationalStatus === "underwater" ? "text-red-400" : "text-white/50"
            }>{(wallet.operationalStatus || "—").toUpperCase()}</span>
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
