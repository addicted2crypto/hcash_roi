import { SNOWTRACE, CONTRACTS, truncAddr } from "@/lib/snowtrace";
import Link from "next/link";

export const revalidate = 300;
export const metadata = {
  title: "Who's actually making money mining hCASH? — hCASH ROI Oracle",
  description: "Live cohort analysis from on-chain receipts. % of players in profit, paper P&L, per-facility breakdown. Computed every 5 minutes from canonical contracts.",
};

async function getCohorts() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const p = path.resolve("data/profitability-cohorts.json");
  if (!fs.existsSync(p)) return null;
  try {
    const stat = fs.statSync(p);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));

    // Augment byFacility with investment P&L cohorts from wallet-pnl.json
    const pnlPath = path.resolve("data/wallet-pnl.json");
    if (fs.existsSync(pnlPath)) {
      const pnl = JSON.parse(fs.readFileSync(pnlPath, "utf8"));
      const invByFac = {};
      for (const w of Object.values(pnl)) {
        const f = w.facilityLevel ?? 0;
        if (!invByFac[f]) invByFac[f] = { realized: 0, paper: 0, underwater: 0 };
        const c = w.cohort || "";
        if (c === "realized_profit") invByFac[f].realized++;
        else if (c === "paper_profit") invByFac[f].paper++;
        else if (c === "underwater") invByFac[f].underwater++;
      }
      for (const row of Object.values(data.byFacility || {})) {
        const iv = invByFac[row.facilityIndex] || { realized: 0, paper: 0, underwater: 0 };
        row.invRealized   = iv.realized;
        row.invPaper      = iv.paper;
        row.invUnderwater = iv.underwater;
      }
    }

    return { ...data, ageMs: Date.now() - stat.mtimeMs, fileUpdatedAt: new Date(stat.mtimeMs).toISOString() };
  } catch { return null; }
}

function VerifyArrow({ href, title }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
       title={title || "Verify on Snowtrace"}
       className="inline-block ml-1 text-[9px] text-white/25 hover:text-cyan-400 transition-colors tracking-wider align-baseline"
       style={{ fontFamily: "'JetBrains Mono', monospace" }}>↗</a>
  );
}

export default async function ProfitabilityPage() {
  const data = await getCohorts();

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center max-w-lg">
          <div className="text-[10px] tracking-[0.3em] text-amber-400/60 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            FIRST SCAN IN PROGRESS
          </div>
          <h1 className="text-2xl font-bold text-white mb-3">Crunching on-chain receipts.</h1>
          <p className="text-white/40 text-sm">
            Reading every <code className="text-amber-400/80">InitialFacilityPurchased</code>,
            {" "}<code className="text-amber-400/80">MinerBoughtWithAvax</code>, marketplace sale, and
            DEX hCASH→AVAX swap from <code className="text-amber-400/80">{CONTRACTS.GAME_MAIN.slice(0,8)}…</code>.
            Page will populate as soon as the snapshot is written.
          </p>
        </div>
      </div>
    );
  }

  const { cohortCounts, operationalCohorts, byFacility, leaderboardTop, leaderboardBottom,
          topHcashHolders = [], topHashrateOwners = [],
          network = {},
          walletsTotal, scanBlock, scannedAt, avaxUsd, hcashUsdSpot, sources } = data;

  const totalInProfit = (cohortCounts.realized_profit + cohortCounts.paper_profit) || 0;
  const profitablePct = walletsTotal > 0 ? (totalInProfit * 100 / walletsTotal) : 0;

  // Lv.0 is the contract placeholder for wallets without an active facility — exclude
  // from the operational table since they're not at a facility level
  const facilityRows = Object.values(byFacility)
    .filter(r => r.facilityIndex > 0)
    .sort((a, b) => a.facilityIndex - b.facilityIndex);

  const stale = data.ageMs > 24 * 60 * 60 * 1000;

  return (
    <div className="min-h-screen pt-12 pb-24 px-6 bg-[#06080e] text-white">
      <div className="ctr">
        {/* ─── HERO ─── */}
        <header className="mb-12">
          <div className="text-[10px] tracking-[0.3em] text-emerald-400/60 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            LIVE LEADERBOARD · FROM ON-CHAIN RECEIPTS{stale && <span className="ml-3 text-amber-400">· STALE</span>}
          </div>
          <h1 className="text-3xl sm:text-5xl md:text-5xl font-bold tracking-tight mb-3">
            <span className="text-emerald-400">Who's actually</span> making money mining hCASH<span className="text-white/20">?</span>
          </h1>
          <p className="text-white/40 text-base md:text-lg">
            Live cohort analysis. Updated every 5 minutes from contracts <code className="text-amber-400/80 text-sm">{truncAddr(CONTRACTS.GAME_MAIN)}</code>{" "}
            and <code className="text-amber-400/80 text-sm">{truncAddr(CONTRACTS.MARKETPLACE)}</code>.
            Numbers below are receipts, not estimates.
          </p>
        </header>

        {/* ─── COHORT CARDS ─── */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-16">
          <CohortCard
            label="REALIZED PROFIT"
            count={cohortCounts.realized_profit}
            total={walletsTotal}
            color="emerald"
            blurb="AVAX out > AVAX in. Already cashed out more than spent."
            verifyHref={SNOWTRACE.tokenTransfers(CONTRACTS.HCASH_TOKEN, sources.pharaohPair)}
          />
          <CohortCard
            label="PAPER PROFIT"
            count={cohortCounts.paper_profit}
            total={walletsTotal}
            color="amber"
            blurb="Holding hCASH worth more than they spent. One sell from green."
            verifyHref={SNOWTRACE.read(CONTRACTS.HCASH_TOKEN, "balanceOf")}
          />
          <CohortCard
            label="UNDERWATER"
            count={cohortCounts.underwater}
            total={walletsTotal}
            color="red"
            blurb="Spent > received + holdings. Counting on emission to recover."
            verifyHref={SNOWTRACE.contract(CONTRACTS.GAME_MAIN)}
          />
        </section>

        {/* ─── PER-FACILITY TABLE (both metrics) ─── */}
        <section className="mb-16">
          <div className="flex items-end justify-between mb-4">
            <div>
              <div className="text-[10px] tracking-[0.3em] text-amber-400/60 mb-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                PROFITABILITY BY FACILITY · TWO METRICS
              </div>
              <h2 className="text-2xl font-bold text-white">Where is mining net-positive right now?</h2>
              <p className="text-white/40 text-sm mt-1">
                <span className="text-cyan-400/70">Operational</span> = daily hCASH earned &gt; daily electricity cost.{" "}
                <span className="text-amber-400/70">Investment</span> = total AVAX received &gt; total AVAX spent (realized + paper).
              </p>
            </div>
            <div className="text-[10px] tracking-wider text-white/20" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {operationalCohorts.profitable} op.profitable / {operationalCohorts.breakeven} breakeven / {operationalCohorts.underwater} underwater
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/5">
            <table className="w-full text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              <thead className="bg-white/2">
                <tr className="text-left text-[10px] tracking-wider text-white/40 uppercase">
                  <th className="py-3 px-4">Lvl</th>
                  <th className="py-3 px-4">Players</th>
                  <th className="py-3 px-4" colSpan={3}>
                    <span className="text-cyan-400/60">OPERATIONAL (daily cash flow)</span>
                  </th>
                  <th className="py-3 px-4">Net hCASH/day</th>
                  <th className="py-3 px-4" colSpan={2}>
                    <span className="text-amber-400/60">INVESTMENT (AVAX recouped)</span>
                  </th>
                </tr>
                <tr className="text-left text-[10px] tracking-wider text-white/30 uppercase border-t border-white/5">
                  <th className="pb-2 px-4"></th>
                  <th className="pb-2 px-4"></th>
                  <th className="pb-2 px-4 text-emerald-400/60">Op.Profitable</th>
                  <th className="pb-2 px-4">Breakeven</th>
                  <th className="pb-2 px-4 text-red-400/50">Op.Underwater</th>
                  <th className="pb-2 px-4">(median)</th>
                  <th className="pb-2 px-4 text-emerald-400/60">Inv.Recouped</th>
                  <th className="pb-2 px-4 text-red-400/50">Inv.Underwater</th>
                </tr>
              </thead>
              <tbody>
                {facilityRows.map((row) => {
                  const opPct  = row.totalPlayers > 0 ? (row.profitable * 100 / row.totalPlayers).toFixed(0) : "0";
                  const invTotal = (row.invRealized ?? 0) + (row.invPaper ?? 0) + (row.invUnderwater ?? 0);
                  const invRecouped = (row.invRealized ?? 0) + (row.invPaper ?? 0);
                  const invPct = invTotal > 0 ? (invRecouped * 100 / invTotal).toFixed(0) : "0";
                  return (
                    <tr key={row.facilityIndex} className="border-t border-white/5 hover:bg-white/2">
                      <td className="py-3 px-4 text-amber-400 font-bold">Lv.{row.facilityIndex}</td>
                      <td className="py-3 px-4 text-white/70">{row.totalPlayers}</td>
                      <td className="py-3 px-4 text-emerald-400">{row.profitable} <span className="text-white/30 text-[10px]">({opPct}%)</span></td>
                      <td className="py-3 px-4 text-white/40">{row.breakeven}</td>
                      <td className="py-3 px-4 text-red-400/80">{row.underwater}</td>
                      <td className={`py-3 px-4 ${row.netHcashDayMedian > 0 ? "text-emerald-400" : row.netHcashDayMedian < 0 ? "text-red-400/80" : "text-white/40"}`}>
                        {row.netHcashDayMedian > 0 ? "+" : ""}{row.netHcashDayMedian.toFixed(2)}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-emerald-400">{invRecouped}</span>
                        <span className="text-white/30 text-[10px] ml-1">({invPct}%)</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-red-400/80">{row.invUnderwater ?? "—"}</span>
                        <a href={SNOWTRACE.read(CONTRACTS.GAME_MAIN, "ownerToFacility")}
                           target="_blank" rel="noopener noreferrer"
                           className="ml-2 text-[10px] text-white/20 hover:text-cyan-400 tracking-wider"
                           title="Re-execute ownerToFacility on Snowtrace">↗</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ─── P&L LEADERBOARDS ─── */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-16">
          <Leaderboard title="TOP 10 GAINERS" rows={leaderboardTop.slice(0, 10)} accent="emerald" />
          <Leaderboard title="TOP 10 UNDERWATER" rows={leaderboardBottom.slice(0, 10)} accent="red" />
        </section>

        {/* ─── CONCENTRATION LEADERBOARDS ─── */}
        <section className="mb-16">
          <div className="mb-4">
            <div className="text-[10px] tracking-[0.3em] text-amber-400/60 mb-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              CONCENTRATION · WHO MOVES THE NETWORK
            </div>
            <h2 className="text-2xl font-bold text-white">The whales worth watching.</h2>
            <p className="text-white/40 text-sm mt-1">
              Token holders set sell-pressure. Hashpower owners set emission share. Track both — they don't always overlap.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <ConcentrationBoard
              title="TOP HCASH HOLDERS"
              rows={topHcashHolders.slice(0, 10)}
              metric="pctOfSupply"
              valueKey="hcashBalance"
              valueFmt={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " hCASH"}
              total={network.hcashTotalSupply}
              totalLabel="hCASH supply"
              verifyHref={SNOWTRACE.read(CONTRACTS.HCASH_TOKEN, "totalSupply")}
              accent="amber"
            />
            <ConcentrationBoard
              title="TOP HASHRATE OWNERS"
              rows={topHashrateOwners.slice(0, 10)}
              metric="pctOfNetwork"
              valueKey="hashrate"
              valueFmt={(v) => v.toLocaleString() + " MH/s"}
              total={network.totalHashrate}
              totalLabel="network hashrate"
              verifyHref={SNOWTRACE.read(CONTRACTS.GAME_MAIN, "totalHashrate")}
              accent="cyan"
            />
          </div>
        </section>

        {/* ─── METHODOLOGY FOOTER ─── */}
        <footer className="border-t border-white/5 pt-8 mt-8 text-[11px] text-white/30" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="text-white/50 mb-2 tracking-wider">SNAPSHOT</div>
              <div>Block: <a href={SNOWTRACE.block(scanBlock)} target="_blank" rel="noopener noreferrer" className="text-cyan-400/70 hover:text-cyan-400">{scanBlock.toLocaleString()} ↗</a></div>
              <div>Computed: {new Date(scannedAt).toUTCString()}</div>
              <div>AVAX/USD spot: ${avaxUsd?.toFixed(4)} · hCASH/USD spot: ${hcashUsdSpot?.toFixed(6)}</div>
            </div>
            <div>
              <div className="text-white/50 mb-2 tracking-wider">SOURCES (verify on-chain ↗)</div>
              <div>Game: <a href={SNOWTRACE.contract(CONTRACTS.GAME_MAIN)} target="_blank" rel="noopener noreferrer" className="text-cyan-400/70 hover:text-cyan-400">{truncAddr(CONTRACTS.GAME_MAIN)} ↗</a></div>
              <div>Marketplace: <a href={SNOWTRACE.contract(CONTRACTS.MARKETPLACE)} target="_blank" rel="noopener noreferrer" className="text-cyan-400/70 hover:text-cyan-400">{truncAddr(CONTRACTS.MARKETPLACE)} ↗</a></div>
              <div>hCASH token: <a href={SNOWTRACE.contract(CONTRACTS.HCASH_TOKEN)} target="_blank" rel="noopener noreferrer" className="text-cyan-400/70 hover:text-cyan-400">{truncAddr(CONTRACTS.HCASH_TOKEN)} ↗</a></div>
            </div>
          </div>
          <div className="mt-6 text-white/20">
            Methodology: per wallet, AVAX in = entry costs (initialFacilityPrice × entries) + MinerBoughtWithAvax events + marketplace AVAX/USDC buys.
            AVAX out = matched hCASH→WAVAX swaps on the Pharaoh pair (Transfer-to-pair joined to Swap by tx hash) + marketplace AVAX/USDC sells.
            Paper value = balanceOf(hCASH) × current Pharaoh AVAX/hCASH ratio. Status: realized = out &gt; in; paper = out + paper &gt; in; underwater = otherwise.
          </div>
        </footer>
      </div>
    </div>
  );
}

function CohortCard({ label, count, total, color, blurb, verifyHref }) {
  const colors = {
    emerald: { bg: "rgba(34,197,94,0.06)", border: "rgba(34,197,94,0.2)", text: "text-emerald-400", dim: "text-emerald-400/60" },
    amber:   { bg: "rgba(245,158,11,0.07)", border: "rgba(245,158,11,0.25)", text: "text-amber-400",  dim: "text-amber-400/60"  },
    red:     { bg: "rgba(239,68,68,0.07)",  border: "rgba(239,68,68,0.25)",  text: "text-red-400",    dim: "text-red-400/60"    },
  }[color];
  const pct = total > 0 ? (count * 100 / total) : 0;
  return (
    <div className="rounded-2xl p-6" style={{ background: colors.bg, border: `1px solid ${colors.border}` }}>
      <div className={`text-[10px] tracking-[0.3em] ${colors.dim} mb-2`} style={{ fontFamily: "'JetBrains Mono', monospace" }}>{label}</div>
      <div className="flex items-baseline gap-3 mb-3">
        <div className={`text-5xl font-extrabold ${colors.text} tabular-nums`} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {count.toLocaleString()}
        </div>
        <div className="text-white/50 text-sm">of {total.toLocaleString()} ({pct.toFixed(1)}%)</div>
      </div>
      <div className="text-white/40 text-xs mb-4">{blurb}</div>
      <a href={verifyHref} target="_blank" rel="noopener noreferrer"
         className={`text-[10px] tracking-wider ${colors.dim} hover:${colors.text} transition-colors`}
         style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        verify on-chain ↗
      </a>
    </div>
  );
}

function ConcentrationBoard({ title, rows, metric, valueKey, valueFmt, total, totalLabel, verifyHref, accent }) {
  const accentClasses = {
    amber: { text: "text-amber-400", dim: "text-amber-400/40", bar: "bg-amber-400/40" },
    cyan:  { text: "text-cyan-400",  dim: "text-cyan-400/40",  bar: "bg-cyan-400/40" },
  }[accent] || { text: "text-white", dim: "text-white/40", bar: "bg-white/40" };

  const top10Pct = rows.reduce((s, r) => s + (r[metric] || 0), 0);

  return (
    <div className="rounded-xl border border-white/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className={`text-[10px] tracking-[0.3em] ${accentClasses.dim}`} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {title}
        </div>
        <div className="text-[10px] text-white/30 tracking-wider" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          top10 = {top10Pct.toFixed(1)}% of {totalLabel}
        </div>
      </div>

      <div className="space-y-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        {rows.map((r, i) => (
          <div key={r.addr} className="flex items-center justify-between text-xs py-2 border-b border-white/3 last:border-0 group">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-white/30 w-6 shrink-0">{i + 1}.</span>
              <Link href={`/wallet/${r.addr}`} className={`${accentClasses.text} hover:underline transition-colors truncate`}>
                {truncAddr(r.addr, 8, 4)}
              </Link>
              {r.facilityLevel != null && r.facilityLevel > 0 && (
                <span className="text-white/30 text-[10px] shrink-0">Lv.{r.facilityLevel}</span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-white/40 tabular-nums hidden md:inline">
                {valueFmt(r[valueKey])}
              </span>
              <span className={`${accentClasses.text} font-bold tabular-nums w-14 text-right`}>
                {r[metric].toFixed(2)}%
              </span>
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="text-white/30 text-xs py-2">No data yet.</div>}
      </div>

      <div className="mt-3 flex justify-between items-center text-[10px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <span className="text-white/30">Total: {total ? total.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</span>
        <a href={verifyHref} target="_blank" rel="noopener noreferrer"
           className={`${accentClasses.dim} hover:${accentClasses.text} tracking-wider transition-colors`}>
          verify ↗
        </a>
      </div>
    </div>
  );
}

function Leaderboard({ title, rows, accent }) {
  const accentColor = accent === "emerald" ? "text-emerald-400" : "text-red-400";
  const accentDim = accent === "emerald" ? "text-emerald-400/40" : "text-red-400/40";
  return (
    <div className="rounded-xl border border-white/5 p-4">
      <div className={`text-[10px] tracking-[0.3em] ${accentDim} mb-3`} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        {title}
      </div>
      <div className="space-y-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        {rows.map((r, i) => (
          <div key={r.addr} className="flex items-center justify-between text-xs py-2 border-b border-white/3 last:border-0">
            <div className="flex items-center gap-3">
              <span className="text-white/30 w-6">{i + 1}.</span>
              <Link href={`/wallet/${r.addr}`} className="text-cyan-400/80 hover:text-cyan-400 transition-colors">
                {truncAddr(r.addr, 8, 4)}
              </Link>
              {r.facilityLevel != null && <span className="text-white/30 text-[10px]">Lv.{r.facilityLevel}</span>}
            </div>
            <div className={`${accentColor} font-bold tabular-nums`}>
              {r.netUsd > 0 ? "+" : ""}${r.netUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="text-white/30 text-xs py-2">No data yet.</div>}
      </div>
    </div>
  );
}
