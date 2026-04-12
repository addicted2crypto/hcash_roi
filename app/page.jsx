'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

// ─── PROTOCOL CONSTANTS ─────────────────────────────────────────────────────
const BLOCK_TIME   = 1.05;
const BLOCKS_DAY   = Math.floor(86400 / BLOCK_TIME);
// HALVING ALREADY HAPPENED — emission is now 1.25 hCASH/block (confirmed from official calc Apr 4 2026)
// Next halving: ~50 days from now
const EMISSION     = 1.25;
const REFRESH_MS   = 5 * 60 * 1000;
// API key is SERVER-SIDE ONLY in /api/floors/route.js — never expose to client

// ─── DEFAULT PRICES (updated 2026-04-04) ────────────────────────────────────
// Network hash: confirmed from dashboard 200.23 GH/s = 200,230 MH/s (Apr 4 2026)
// Defaults updated Apr 11 2026 — live data overwrites these on load
const DEF = { hcashUsd: 0.084, hcashAvax: 0.00891, avaxUsd: 9.56, netHash: 209253 };

// Halving: next halving at block 4,098,527 (from dashboard Apr 4 2026)
// At ~82,285 blocks/day this is approximately 50 days from Apr 4
// Fallback only — live value comes from /api/game (blocksUntilNextHalving)
const NEXT_HALVING_BLOCKS = 3506186;
const HALVING_EMISSION    = 0.625; // post-next-halving emission

// ─── PRICE SOURCES ──────────────────────────────────────────────────────────
const AVAX_RPC = "https://api.avax.network/ext/bc/C/rpc";
const DS_API   = "https://api.dexscreener.com/latest/dex/search?q=hCASH";
const CL_AVAX  = "0x0A77230d17318075983913bC2145DB16C7366156";
const CL_SEL   = "0xfeaf968c";

// ─── FACILITIES (updated 2026-04-04) ────────────────────────────────────────
const FACILITIES = [
  // elecRate = hCASH per kWh
  // totalHcash = cumulative upgrade cost to reach this level
  // UPDATED Apr 6 2026: F2 now FREE, F3 1500, F4 4000, F5 15000 unchanged (@clubhashcash)
  { id:"l1", lvl:1, name:"Lv.1", grid:"2×2", slots:4,  powerW:400,   elecRate:8.69, cooldownD:0,  costAvax:2, totalHcash:0,     color:"#4ade80" },
  { id:"l2", lvl:2, name:"Lv.2", grid:"2×3", slots:6,  powerW:1000,  elecRate:6.98, cooldownD:3,  costAvax:0, totalHcash:0,     color:"#22d3ee" },  // FREE upgrade
  { id:"l3", lvl:3, name:"Lv.3", grid:"3×3", slots:9,  powerW:2000,  elecRate:6.11, cooldownD:7,  costAvax:0, totalHcash:1500,  color:"#818cf8" },  // 0 + 1500
  { id:"l4", lvl:4, name:"Lv.4", grid:"3×4", slots:12, powerW:6000,  elecRate:6.99, cooldownD:14, costAvax:0, totalHcash:5500,  color:"#f472b6" },  // 0 + 1500 + 4000
  { id:"l5", lvl:5, name:"Lv.5", grid:"4×4", slots:16, powerW:15000, elecRate:3.50, cooldownD:14, costAvax:0, totalHcash:20500, color:"#fbbf24" },  // 0 + 1500 + 4000 + 15000
  { id:"l6", lvl:6, name:"Lv.6", grid:"5×5", slots:24, powerW:22500, elecRate:3.52, cooldownD:14, costAvax:0, totalHcash:45000, color:"#f43f5e" },  // est: 20500 + ~24500
];

// ─── MINERS (from API, with market floor prices hCASH from hashcash.club) ───
// We'll load from API but keep hardcoded floor prices as fallback
// Prices: "list" = official shop price, "floor" = marketplace floor (cheaper!)
// ─── LIVE MARKETPLACE FLOOR PRICES (from on-chain scan Apr 4 2026) ───────────
// These are REAL floor prices from getAllValidListings() on the marketplace contract
// Updated dynamically — this is our edge over the official calc which uses list prices
const STATIC_MINERS = [
  // --- LIVE ON MARKETPLACE (floor prices confirmed on-chain) ---
  { id:"miner1",  name:"Home Brew CPU Miner",     hash:10,   powerW:100,  costHcash:99,    avail:true,  img:"https://cdn.popularhost.net/hashclub/1/1.png" },
  { id:"miner2",  name:"RedDragon",               hash:14,   powerW:100,  costHcash:175,   avail:true,  img:"https://cdn.popularhost.net/hashclub/2/1.png" },
  { id:"miner14", name:"Plasma Base",             hash:25,   powerW:100,  costHcash:200,   avail:true,  img:"https://cdn.popularhost.net/hashclub/14/1.png" },
  { id:"miner6",  name:"Quad Socket CPU",         hash:40,   powerW:200,  costHcash:200,   avail:true,  img:"https://cdn.popularhost.net/hashclub/6/1.png" },
  { id:"miner21", name:"RedDragon Quadro v2.0",   hash:70,   powerW:400,  costHcash:200,   avail:true,  img:"https://cdn.popularhost.net/hashclub/21/1.png" },
  { id:"miner11", name:"Lightning G1",            hash:20,   powerW:100,  costHcash:300,   avail:true,  img:"https://cdn.popularhost.net/hashclub/11/1.png" },
  { id:"miner12", name:"Lightning G2",            hash:35,   powerW:200,  costHcash:300,   avail:true,  img:"https://cdn.popularhost.net/hashclub/12/1.png" },
  { id:"miner3",  name:"RedDragon Ti",            hash:24,   powerW:300,  costHcash:350,   avail:true,  img:"https://cdn.popularhost.net/hashclub/3/1.png" },
  { id:"miner15", name:"Plasma XL",               hash:45,   powerW:200,  costHcash:400,   avail:true,  img:"https://cdn.popularhost.net/hashclub/15/1.png" },
  { id:"miner20", name:"RedDragon Ti Duo v2.0",   hash:70,   powerW:400,  costHcash:420,   avail:true,  img:"https://cdn.popularhost.net/hashclub/20/1.png" },
  { id:"miner29", name:"CPU Miner v2.0",          hash:30,   powerW:100,  costHcash:450,   avail:true,  img:"https://cdn.popularhost.net/hashclub/29/1.png" },
  { id:"miner22", name:"RedDragon Quadro Ti v2.0",hash:110,  powerW:800,  costHcash:500,   avail:true,  img:"https://cdn.popularhost.net/hashclub/22/1.png" },
  { id:"miner32", name:"RedDragon TiX",           hash:45,   powerW:100,  costHcash:650,   avail:true,  img:"https://cdn.popularhost.net/hashclub/32/1.png" },
  { id:"miner34", name:"Ennea Socket CPU",        hash:90,   powerW:200,  costHcash:750,   avail:true,  img:"https://cdn.popularhost.net/hashclub/34/1.png" },
  { id:"miner36", name:"Lightning G1 Quad-Rig",   hash:80,   powerW:200,  costHcash:750,   avail:true,  img:"https://cdn.popularhost.net/hashclub/36/1.png" },
  { id:"miner26", name:"Plasma XXL",              hash:60,   powerW:200,  costHcash:900,   avail:true,  img:"https://cdn.popularhost.net/hashclub/26/1.png" },
  { id:"miner37", name:"Lightning G2 Quad-Rig",   hash:140,  powerW:400,  costHcash:1000,  avail:true,  img:"https://cdn.popularhost.net/hashclub/37/1.png" },
  { id:"miner23", name:"WindHash Red",            hash:125,  powerW:600,  costHcash:1250,  avail:true,  img:"https://cdn.popularhost.net/hashclub/23/1.png" },
  { id:"miner25", name:'HashTech "Mini Beast"',    hash:150,  powerW:500,  costHcash:1550,  avail:true,  img:"https://cdn.popularhost.net/hashclub/25/1.png" },
  { id:"miner35", name:"Quad Socket CPU v2.0",    hash:120,  powerW:200,  costHcash:2000,  avail:true,  img:"https://cdn.popularhost.net/hashclub/35/1.png" },
  { id:"miner17", name:'HashTech "The Beast"',     hash:200,  powerW:1000, costHcash:2120,  avail:true,  img:"https://cdn.popularhost.net/hashclub/17/1.png" },
  { id:"miner47", name:"Jvidia JX420",            hash:280,  powerW:500,  costHcash:3200,  avail:true,  img:"https://cdn.popularhost.net/hashclub/47/1.png" },
];

// ─── RPC HELPERS ─────────────────────────────────────────────────────────────
async function rpc(method, params = []) {
  const r = await fetch(AVAX_RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
  });
  return (await r.json()).result;
}
async function getAvaxUsd() {
  const res = await rpc("eth_call", [{ to: CL_AVAX, data: CL_SEL }, "latest"]);
  if (!res || res.length < 130) return null;
  const v = parseInt(res.slice(66, 130), 16);
  return v > 0 && v < 1e13 ? v / 1e8 : null;
}
async function getDex() {
  const d = await fetch(DS_API).then(r => r.json());
  const p = (d.pairs || []).find(p =>
    p.chainId === "avalanche" &&
    (p.baseToken?.symbol?.toUpperCase() === "HCASH" || p.quoteToken?.symbol?.toUpperCase() === "HCASH")
  );
  if (!p) return null;
  const isBase = p.baseToken?.symbol?.toUpperCase() === "HCASH";
  return {
    ratio: isBase ? parseFloat(p.priceNative) : 1 / parseFloat(p.priceNative),
    usd: parseFloat(p.priceUsd || 0),
    ch1h: p.priceChange?.h1 ?? 0, ch6h: p.priceChange?.h6 ?? 0, ch24h: p.priceChange?.h24 ?? 0,
    vol24: parseFloat(p.volume?.h24 || 0), liq: parseFloat(p.liquidity?.usd || 0),
    mcap: parseFloat(p.marketCap || 0),
  };
}

// ─── CORE MATH ───────────────────────────────────────────────────────────────
// Days until next halving (emission 1.25 → 0.625)
const HALVING_DAY = Math.round(NEXT_HALVING_BLOCKS / BLOCKS_DAY);

function calcPath(facility, miner, count, netHash, hcashUsd, avaxUsd, hcashAvax, includeHalving = true, emissionRate = EMISSION) {
  const myHash    = count * miner.hash;
  const share     = myHash / (netHash + myHash);
  const grossDay  = BLOCKS_DAY * emissionRate * share;
  const grossDayPost = BLOCKS_DAY * (emissionRate / 2) * share; // post-halving
  // elecRate is hCASH per kWh — multiply by 24 hours for daily cost
  const elecDay   = (count * miner.powerW / 1000) * facility.elecRate * 24;
  const netDay    = grossDay - elecDay;         // pre-halving daily net
  const netDayPost = grossDayPost - elecDay;    // post-halving daily net
  const netDayUsd = netDay * hcashUsd;
  const netDayPostUsd = netDayPost * hcashUsd;
  const facAvaxCost  = 2;
  const facHcashCost = facility.totalHcash;
  const minerHcash   = count * miner.costHcash;
  const totalHcash   = facHcashCost + minerHcash;
  const totalAvax    = facAvaxCost + totalHcash * hcashAvax;
  const totalUsd     = totalAvax * avaxUsd;

  // Breakeven accounting for halving
  let breakEvenDays;
  if (netDayUsd <= 0) {
    breakEvenDays = Infinity;
  } else if (!includeHalving) {
    // No halving — simple linear breakeven
    breakEvenDays = totalUsd / netDayUsd;
  } else {
    const earnedBeforeHalving = netDayUsd * HALVING_DAY;
    if (earnedBeforeHalving >= totalUsd) {
      breakEvenDays = totalUsd / netDayUsd;
    } else if (netDayPostUsd <= 0) {
      breakEvenDays = Infinity;
    } else {
      const remaining = totalUsd - earnedBeforeHalving;
      breakEvenDays = HALVING_DAY + remaining / netDayPostUsd;
    }
  }

  return {
    facility, miner, count, myHash, share, grossDay, elecDay, netDay, netDayUsd,
    netDayPost, netDayPostUsd, includeHalving,
    totalHcash, totalAvax, totalUsd, breakEvenDays,
    powerUsed: count * miner.powerW, powerPct: (count * miner.powerW) / facility.powerW,
    monthlyUsd: netDayUsd * 30, yearlyUsd: netDayUsd * 365,
  };
}

function bestForFacility(fac, budgetAvax, miners, netHash, hcashUsd, avaxUsd, hcashAvax, includeHalving = true, emissionRate = EMISSION) {
  let best = null;
  const budgetHcash = (budgetAvax - 2) / hcashAvax;
  for (const m of miners) {
    if (m.hash <= 0) continue;
    const remainHcash = budgetHcash - fac.totalHcash;
    if (remainHcash < m.costHcash) continue;
    const byBudget = Math.floor(remainHcash / m.costHcash);
    const bySlots  = fac.slots;
    const byPower  = m.powerW > 0 ? Math.floor(fac.powerW / m.powerW) : fac.slots;
    const count    = Math.min(byBudget, bySlots, byPower);
    if (count < 1) continue;
    const path = calcPath(fac, m, count, netHash, hcashUsd, avaxUsd, hcashAvax, includeHalving, emissionRate);
    if (path.netDay <= 0) continue;
    if (!best || path.breakEvenDays < best.breakEvenDays) best = path;
  }
  return best;
}

function buildProjection(path, days) {
  if (!path) return [];
  const pts = [];
  const step = days > 365 ? 14 : days > 180 ? 7 : days > 60 ? 2 : 1;
  for (let d = 0; d <= days; d += step) {
    let earned;
    if (!path.includeHalving || d <= HALVING_DAY) {
      earned = path.netDayUsd * d;
    } else {
      earned = path.netDayUsd * HALVING_DAY + path.netDayPostUsd * (d - HALVING_DAY);
    }
    pts.push({ day: d, pnl: +(earned - path.totalUsd).toFixed(2), earn: +earned.toFixed(2) });
  }
  // Ensure halving day is a data point for the visible bend (only when halving enabled)
  if (path.includeHalving && HALVING_DAY > 0 && HALVING_DAY < days && !pts.find(p => p.day === HALVING_DAY)) {
    const earnH = path.netDayUsd * HALVING_DAY;
    pts.push({ day: HALVING_DAY, pnl: +(earnH - path.totalUsd).toFixed(2), earn: +earnH.toFixed(2) });
    pts.sort((a, b) => a.day - b.day);
  }
  return pts;
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [px, setPx] = useState({
    hcashUsd: DEF.hcashUsd, avaxUsd: DEF.avaxUsd, hcashAvax: DEF.hcashAvax,
    ch24h: 0, vol24: 0, liq: 0, mcap: 0, loading: true, src: "default"
  });
  const [netHash, setNetHash] = useState(DEF.netHash);
  const [budget, setBudget]   = useState(50);
  const [unit, setUnit]       = useState("avax");
  const [chartDays, setChartDays] = useState(0);
  const [selFac, setSelFac]   = useState(null);
  const [miners, setMiners]   = useState(STATIC_MINERS);
  const [facs, setFacs]       = useState(FACILITIES);
  const [floorsLive, setFloorsLive] = useState(false);
  const [gameLive, setGameLive] = useState(false);
  const [liveEmission, setLiveEmission] = useState(EMISSION);
  const [liveHalvingDays, setLiveHalvingDays] = useState(HALVING_DAY);
  const [showTable, setShowTable] = useState(false);
  const [tableSort, setTableSort] = useState({ key: "mhw", dir: "desc" });
  const [halvingOn, setHalvingOn] = useState(false);

  const budgetAvax  = unit === "usd" ? budget / px.avaxUsd : budget;
  const budgetUsd   = budgetAvax * px.avaxUsd;
  const budgetHcash = budgetAvax / px.hcashAvax;

  // ─── Fetch prices ───
  const fetchPrices = useCallback(async () => {
    let avaxUsd = DEF.avaxUsd, src = "default";
    try { const cl = await getAvaxUsd(); if (cl) { avaxUsd = cl; src = "chainlink"; } } catch {}
    let dex = null;
    try { dex = await getDex(); } catch {}
    const hcashAvax = dex?.ratio || DEF.hcashAvax;
    const hcashUsd  = dex?.usd || hcashAvax * avaxUsd;
    setPx({
      hcashUsd, avaxUsd, hcashAvax,
      ch24h: dex?.ch24h || 0, vol24: dex?.vol24 || 0, liq: dex?.liq || 0, mcap: dex?.mcap || 0,
      loading: false, src,
    });
  }, []);

  // ─── Fetch live marketplace floor prices ───
  const fetchFloors = useCallback(async () => {
    try {
      const res = await fetch("/api/floors");
      const data = await res.json();
      if (data.miners && data.miners.length > 0) {
        setMiners(data.miners);
        setFloorsLive(true);
      }
    } catch {}
  }, []);

  // ─── Fetch live game state (facilities, network, halving) ───
  const fetchGame = useCallback(async () => {
    try {
      const res = await fetch("/api/game");
      const data = await res.json();
      if (data.network) {
        setNetHash(data.network.totalHashrate);
        setLiveEmission(data.network.emission);
        setLiveHalvingDays(data.network.halvingDays);
        setGameLive(true);
      }
      if (data.facilities && data.facilities.length > 0) {
        // Merge live contract data with our hardcoded fallbacks
        // Contract may not have all levels (e.g., Lv.5 might be separate)
        setFacs(prev => {
          const colors = ["#4ade80","#22d3ee","#818cf8","#f472b6","#fbbf24","#f43f5e"];
          const liveFacs = data.facilities.map((f, i) => ({
            id: `l${f.lvl}`,
            lvl: f.lvl,
            name: `Lv.${f.lvl}`,
            grid: f.grid,
            slots: f.slots,
            powerW: f.powerW,
            elecRate: f.elecRate,
            cooldownD: f.cooldownD,
            costAvax: f.costAvax || 0,
            totalHcash: f.totalHcash || 0,
            color: colors[i] || "#9ca3af",
          }));
          // Keep any hardcoded levels beyond what the contract returned
          const maxLiveLvl = Math.max(...liveFacs.map(f => f.lvl));
          const extras = prev.filter(f => f.lvl > maxLiveLvl);
          return [...liveFacs, ...extras];
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchPrices();
    fetchFloors();
    fetchGame();
    const iv = setInterval(fetchPrices, REFRESH_MS);
    const iv2 = setInterval(fetchFloors, REFRESH_MS);
    const iv3 = setInterval(fetchGame, REFRESH_MS);
    return () => { clearInterval(iv); clearInterval(iv2); clearInterval(iv3); };
  }, [fetchPrices, fetchFloors, fetchGame]);

  // ─── Compute paths ───
  const allPaths = useMemo(() => {
    return facs.map(f => bestForFacility(f, budgetAvax, miners, netHash, px.hcashUsd, px.avaxUsd, px.hcashAvax, halvingOn, liveEmission)).filter(Boolean);
  }, [budgetAvax, netHash, px, miners, halvingOn, facs, liveEmission]);

  const bestPath = allPaths.length > 0 ? allPaths.reduce((a, b) => a.breakEvenDays < b.breakEvenDays ? a : b) : null;
  const topPaths = useMemo(() => [...allPaths].sort((a, b) => a.breakEvenDays - b.breakEvenDays).slice(0, 3), [allPaths]);
  const activePath = selFac ? allPaths.find(p => p.facility.id === selFac) || bestPath : bestPath;
  // Auto-scale chart to ~2x breakeven so the crossover is in the middle
  const autoChartDays = useMemo(() => {
    if (!activePath || !isFinite(activePath.breakEvenDays)) return 180;
    const twoBe = Math.ceil(activePath.breakEvenDays * 2);
    // Snap to nice values
    if (twoBe <= 30) return 30;
    if (twoBe <= 60) return 60;
    if (twoBe <= 90) return 90;
    if (twoBe <= 180) return 180;
    if (twoBe <= 365) return 365;
    return 730;
  }, [activePath]);
  const effectiveChartDays = chartDays || autoChartDays;
  const chartData = useMemo(() => buildProjection(activePath, effectiveChartDays), [activePath, effectiveChartDays]);

  // ─── Helpers ───
  const fmtDays = (d) => {
    if (!isFinite(d) || d > 9999) return "Never";
    if (d > 365) return `${(d/365).toFixed(1)} years`;
    if (d > 30) return `${(d/30).toFixed(1)} months`;
    return `${Math.ceil(d)} days`;
  };
  const dayColor = (d) => d > 365 ? "#ef4444" : d > 180 ? "#f97316" : d > 90 ? "#eab308" : d > 30 ? "#22d3ee" : "#22c55e";

  return (
    <div className="min-h-screen w-full text-slate-100" style={{ background: "#06080e", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        .ctr { width: 100%; max-width: 1024px; margin-left: auto !important; margin-right: auto !important; padding-left: 24px; padding-right: 24px; }
        .ctr-sm { width: 100%; max-width: 640px; margin-left: auto !important; margin-right: auto !important; padding-left: 16px; padding-right: 16px; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }

        .slider-track {
          -webkit-appearance: none; appearance: none; width: 100%;
          height: 8px; border-radius: 999px; outline: none; cursor: pointer;
          display: block; margin: 0 auto;
          background: linear-gradient(90deg,
            #22c55e 0%, #22c55e 5%,
            #eab308 20%, #f97316 50%,
            #ef4444 80%, #7f1d1d 100%
          );
          opacity: 0.85;
        }
        .slider-track::-webkit-slider-thumb {
          -webkit-appearance: none; width: 28px; height: 28px; border-radius: 50%;
          background: #fff; border: 3px solid #06080e;
          box-shadow: 0 0 0 2px rgba(255,255,255,0.3), 0 4px 16px rgba(0,0,0,0.5);
          cursor: grab; transition: box-shadow 0.2s;
        }
        .slider-track::-webkit-slider-thumb:hover {
          box-shadow: 0 0 0 4px rgba(255,255,255,0.4), 0 4px 24px rgba(0,0,0,0.6);
        }
        .slider-track:active::-webkit-slider-thumb { cursor: grabbing; }

        @keyframes fadeSlide { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        .fade-slide { animation: fadeSlide 0.4s ease forwards; }
        @keyframes glow { 0%,100% { opacity:0.5; } 50% { opacity:1; } }
        .glow { animation: glow 2s ease infinite; }

        @keyframes scrollUp {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }
        .side-feed {
          position: fixed; top: 0; width: 160px; height: 100vh;
          overflow: hidden; pointer-events: none; z-index: 0;
          mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
          -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
        }
        .side-feed-left { left: 0; }
        .side-feed-right { right: 0; }
        .side-feed-inner {
          animation: scrollUp 60s linear infinite;
          display: flex; flex-direction: column; gap: 12px; padding: 20px 12px;
        }
        .side-feed-right .side-feed-inner {
          animation-duration: 75s;
          animation-direction: reverse;
        }
        .side-feed:hover .side-feed-inner {
          animation-play-state: paused;
        }
        .side-feed:hover { pointer-events: auto; }
        .side-item {
          background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
          border-radius: 10px; padding: 10px; text-align: center;
          font-family: 'JetBrains Mono', monospace; opacity: 0.35;
          transition: all 0.3s; cursor: default; pointer-events: auto;
        }
        .side-item:hover {
          opacity: 0.9; transform: scale(1.05);
          background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1);
        }
        .side-item.best-deal {
          opacity: 0.7; border-color: #22c55e40;
          background: rgba(34,197,94,0.05);
        }
        .side-item.best-deal::after {
          content: 'BEST MH/$'; display: block;
          font-size: 8px; color: #22c55e; letter-spacing: 1px;
          margin-top: 4px; font-weight: 700;
        }
        .side-item.newest {
          opacity: 0.8; border-color: #fbbf2440;
          background: rgba(251,191,36,0.05);
        }
        .side-item.newest::after {
          content: 'NEW LISTING'; display: block;
          font-size: 8px; color: #fbbf24; letter-spacing: 1px;
          margin-top: 4px; font-weight: 700;
        }
        @media (max-width: 1400px) { .side-feed { display: none; } }

        .path-card {
          position: relative; border-radius: 16px; padding: 24px;
          background: linear-gradient(145deg, #0f1318 0%, #0a0d12 100%);
          border: 1px solid #1e293b; transition: all 0.25s ease; cursor: pointer;
          overflow: hidden;
        }
        .path-card::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
          background: var(--accent); opacity: 0.6; transition: opacity 0.25s;
        }
        .path-card:hover { border-color: #334155; transform: translateY(-3px); }
        .path-card:hover::before { opacity: 1; }
        .path-card.active { border-color: var(--accent); }
        .path-card.active::before { opacity: 1; height: 4px; }
        .path-card.best::after {
          content: 'BEST ROI'; position: absolute; top: 12px; right: -28px;
          background: var(--accent); color: #000; font-size: 9px; font-weight: 800;
          padding: 3px 32px; transform: rotate(45deg); letter-spacing: 1.5px;
          font-family: 'JetBrains Mono', monospace;
        }

        .stat-pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 12px; border-radius: 8px;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
          font-family: 'JetBrains Mono', monospace; font-size: 12px;
        }
      `}</style>

      {/* ═══ LIVE MARKETPLACE SIDE FEEDS ═══ */}
      {floorsLive && miners.length > 0 && (() => {
        // Find best deal = highest MH per hCASH spent
        const withEff = miners.filter(m => m.hash > 0 && m.costHcash > 0).map(m => ({ ...m, mhPerHcash: m.hash / m.costHcash }));
        const bestDealName = withEff.length > 0 ? withEff.reduce((a, b) => a.mhPerHcash > b.mhPerHcash ? a : b).name : "";
        // Newest = last in array (highest listing ID from chain scan)
        const newestName = miners.length > 0 ? miners[miners.length - 1].name : "";

        const SideItem = ({ m, idx }) => {
          const isBest = m.name === bestDealName;
          const isNew = m.name === newestName;
          const eff = m.costHcash > 0 ? (m.hash / m.costHcash).toFixed(3) : "0";
          return (
            <div key={idx} className={`side-item ${isBest ? "best-deal" : ""} ${isNew && !isBest ? "newest" : ""}`}
              onClick={() => { setShowTable(true); setTimeout(() => document.getElementById('marketplace')?.scrollIntoView({ behavior: 'smooth' }), 100); }}>
              {m.img && <img src={m.img} alt="" style={{ width: 48, height: 48, borderRadius: 8, margin: '0 auto 6px', objectFit: 'cover' }} onError={e => e.target.style.display='none'} />}
              <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2, lineHeight: 1.3 }}>{m.name}</div>
              <div style={{ fontSize: 14, color: '#fbbf24', fontWeight: 700 }}>{m.costHcash?.toLocaleString()}</div>
              <div style={{ fontSize: 9, color: '#4b5563' }}>hCASH</div>
              <div style={{ fontSize: 9, color: '#6b7280', marginTop: 3 }}>{m.hash} MH/s · {m.powerW}W</div>
              <div style={{ fontSize: 9, color: isBest ? '#22c55e' : '#374151', marginTop: 2 }}>{eff} MH/$</div>
            </div>
          );
        };

        return (
        <>
          <div className="side-feed side-feed-left">
            <div className="side-feed-inner">
              {[...miners, ...miners].map((m, i) => <SideItem key={`l${i}`} m={m} idx={i} />)}
            </div>
          </div>
          <div className="side-feed side-feed-right">
            <div className="side-feed-inner">
              {[...miners].reverse().concat([...miners].reverse()).map((m, i) => <SideItem key={`r${i}`} m={m} idx={i} />)}
            </div>
          </div>
        </>
        );
      })()}

      {/* ═══ TOP BAR ═══ */}
      <div className="w-full border-b border-white/5" style={{ background: "rgba(255,255,255,0.01)" }}>
        <div className="ctr flex items-center justify-center gap-4 px-5 py-3 text-xs whitespace-nowrap" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          <span className="font-black text-amber-400 tracking-widest text-[13px]">hCASH</span>
          <span className="text-white text-sm font-bold">${px.hcashUsd.toFixed(4)}</span>
          <span className={px.ch24h >= 0 ? "text-emerald-400" : "text-red-400"}>{px.ch24h >= 0 ? "+" : ""}{px.ch24h.toFixed(1)}%</span>
          <span className="text-white/10">|</span>
          <span className="text-red-400 font-bold">AVAX</span>
          <span className="text-white font-bold">${px.avaxUsd.toFixed(2)}</span>
          <span className="text-white/10">|</span>
          <span className="text-white/30">VOL <span className="text-white/60">${(px.vol24/1000).toFixed(1)}K</span></span>
          <span className="text-white/30">LIQ <span className="text-white/60">${(px.liq/1000).toFixed(1)}K</span></span>
          <span className="text-white/30">MCAP <span className="text-white/60">${(px.mcap/1000).toFixed(1)}K</span></span>
          <span className="text-white/10">|</span>
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${px.loading ? "bg-amber-400 glow" : "bg-emerald-400"}`} />
            <span className="text-white/20">{px.src === "chainlink" ? "CL" : "est"}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${floorsLive ? "bg-cyan-400" : "bg-amber-400 glow"}`} />
            <span className="text-white/20">{floorsLive ? `${miners.length} miners` : "loading..."}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${gameLive ? "bg-emerald-400" : "bg-amber-400 glow"}`} />
            <span className="text-white/20">{gameLive ? `${facs.length} facs · halving ${liveHalvingDays}d` : "loading game..."}</span>
          </div>
          <span className="text-white/10">|</span>
          <a href="#marketplace" onClick={(e) => { e.preventDefault(); setShowTable(true); document.getElementById('marketplace')?.scrollIntoView({ behavior: 'smooth' }); }}
            className="text-cyan-400/60 hover:text-cyan-400 transition-colors cursor-pointer tracking-wider">MARKETPLACE</a>
        </div>
      </div>

      {/* ═══ HERO ═══ */}
      <div className="relative w-full">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-50 left-1/2 -translate-x-1/2 w-250 h-150 rounded-full"
            style={{ background: "radial-gradient(ellipse, rgba(234,179,8,0.04) 0%, transparent 70%)" }} />
        </div>

        <div className="relative ctr px-6 pt-20 pb-10 text-center">
          <div className="mb-14">
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-4">
              <span className="text-amber-400">How much</span> does it
              <br />really cost<span className="text-white/20">?</span>
            </h1>
            <p className="text-white/40 text-lg ctr-sm">
              The unfiltered truth about hCASH mining ROI.
              Drag the slider. See the math. No BS.
            </p>
          </div>

          {/* Unit toggle */}
          <div className="flex justify-center gap-2 mb-8">
            {[["avax","AVAX"],["usd","USD"]].map(([k,l]) => (
              <button key={k} onClick={() => {
                if (k === "usd" && unit === "avax") setBudget(Math.min(Math.round(budget * px.avaxUsd), 9000));
                else if (k === "avax" && unit === "usd") setBudget(Math.min(Math.round(budget / px.avaxUsd), 1000));
                setUnit(k);
              }}
                className={`px-5 py-2 rounded-full text-sm font-bold tracking-wider transition-all
                  ${unit === k ? "bg-white text-black" : "text-white/30 hover:text-white/60"}`}
              >{l}</button>
            ))}
          </div>

          {/* Big number */}
          <div className="mb-6">
            <div className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tighter" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {unit === "usd" && "$"}{budget.toLocaleString()}
              {unit === "avax" && <span className="text-3xl text-amber-400 ml-2 font-bold">AVAX</span>}
            </div>
            <div className="mt-4 flex flex-wrap justify-center gap-2 sm:gap-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              <span className="text-white/30 text-sm">
                <span className="text-amber-400/60">${budgetUsd.toFixed(0)}</span> USD
              </span>
              <span className="text-white/10">·</span>
              <span className="text-white/30 text-sm">
                <span className="text-red-400/60">{budgetAvax.toFixed(1)}</span> AVAX
              </span>
              <span className="text-white/10">·</span>
              <span className="text-white/30 text-sm">
                <span className="text-amber-300/60">{Math.floor(budgetHcash).toLocaleString()}</span> hCASH
              </span>
            </div>
          </div>

          {/* Slider */}
          <div className="ctr-sm px-2">
            <input type="range" className="slider-track"
              min={unit === "usd" ? 10 : 2} max={unit === "usd" ? 9000 : 1000}
              step={unit === "usd" ? 5 : 1} value={budget}
              onChange={e => setBudget(+e.target.value)} />
            <div className="flex justify-between mt-3 text-[10px] tracking-wider text-white/20" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              <span>{unit === "usd" ? "$10" : "2 AVAX"}</span>
              <span className="text-white/10">▲ SLIDE ▲</span>
              <span>{unit === "usd" ? "$9,000" : "1,000 AVAX"}</span>
            </div>
            {/* Whale button */}
            <div className="flex justify-center mt-4">
              <button onClick={() => { setUnit("avax"); setBudget(5000); }}
                className="px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all text-white/20 border border-white/5 hover:border-amber-500/30 hover:text-amber-400"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                🐋 WHALE MODE (5,000 AVAX)
              </button>
            </div>
            {/* Halving toggle */}
            <div className="flex justify-center mt-4 gap-3">
              <button onClick={() => setHalvingOn(false)}
                className={`px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all border
                  ${!halvingOn ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400" : "text-white/20 border-white/5 hover:text-white/40"}`}
                style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                Current Rates
              </button>
              <button onClick={() => setHalvingOn(true)}
                className={`px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all border
                  ${halvingOn ? "bg-red-500/15 border-red-500/30 text-red-400" : "text-white/20 border-white/5 hover:text-white/40"}`}
                style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                With Halving (~{HALVING_DAY}d away)
              </button>
            </div>
          </div>
          {/* Network + halving indicator */}
          <div className="text-center mt-4 text-[10px] text-white/15" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {gameLive && <span className="text-emerald-400/40 mr-1">LIVE</span>}
            Network: {(netHash/1000).toFixed(0)}k MH/s · Emission: {liveEmission} hCASH/block ·{" "}
            <span className="text-amber-400/50">Halving in ~{liveHalvingDays}d: {liveEmission} &rarr; {(liveEmission/2).toFixed(3)} hCASH/block</span>
          </div>
        </div>
      </div>

      {/* ═══ RESULTS ═══ */}
      {allPaths.length > 0 ? (
        <div className="w-full ctr px-6 pb-20">

          {/* ─── TOP ROI PICKS ─── */}
          {topPaths.length > 0 && (
            <div className="fade-slide mb-10">
              <div className="text-center mb-6">
                <div className="text-white/20 text-xs tracking-[0.3em] mb-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  TOP {topPaths.length} FASTEST ROI AT {budgetAvax.toFixed(0)} AVAX
                </div>
              </div>
              <div className={`grid gap-4 ${topPaths.length === 1 ? "grid-cols-1 max-w-md mx-auto" : topPaths.length === 2 ? "grid-cols-2 max-w-2xl mx-auto" : "grid-cols-1 md:grid-cols-3"}`}>
                {topPaths.map((path, i) => (
                  <div key={path.facility.id + path.miner.id}
                    onClick={() => setSelFac(path.facility.id)}
                    className="cursor-pointer rounded-xl p-5 transition-all hover:border-white/10"
                    style={{
                      background: i === 0 ? "linear-gradient(145deg, rgba(251,191,36,0.06), rgba(251,191,36,0.02))" : "rgba(255,255,255,0.02)",
                      border: `1px solid ${i === 0 ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.04)"}`,
                    }}>
                    {/* Rank */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black"
                        style={{ background: i === 0 ? "#fbbf2420" : i === 1 ? "#94a3b820" : "#78716c20", color: i === 0 ? "#fbbf24" : i === 1 ? "#94a3b8" : "#78716c", fontFamily: "'JetBrains Mono'" }}>
                        #{i + 1}
                      </div>
                      <div>
                        <div className="text-white font-bold text-sm">{path.facility.name} + {path.count}× {path.miner.name}</div>
                        <div className="text-white/20 text-[10px]" style={{ fontFamily: "'JetBrains Mono'" }}>{path.myHash.toLocaleString()} MH/s · {path.powerUsed}W</div>
                      </div>
                    </div>
                    {/* Stats row */}
                    <div className="grid grid-cols-4 gap-2 text-center" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                      <div>
                        <div className="text-white/20 text-[8px] tracking-wider">INVEST</div>
                        <div className="text-white font-bold text-sm">${path.totalUsd.toFixed(0)}</div>
                        <div className="text-white/10 text-[9px]">{path.totalAvax.toFixed(1)} AVAX</div>
                      </div>
                      <div>
                        <div className="text-white/20 text-[8px] tracking-wider">BREAK-EVEN</div>
                        <div className="font-bold text-sm" style={{ color: dayColor(path.breakEvenDays) }}>{fmtDays(path.breakEvenDays)}</div>
                      </div>
                      <div>
                        <div className="text-white/20 text-[8px] tracking-wider">DAILY NET</div>
                        <div className={`font-bold text-sm ${path.netDayUsd > 0 ? "text-emerald-400" : "text-red-400"}`}>${path.netDayUsd.toFixed(2)}</div>
                        <div className="text-white/10 text-[9px]">{path.netDay.toFixed(0)} hCASH</div>
                        <div className="text-white/8 text-[8px]">gross {path.grossDay.toFixed(0)} - elec {path.elecDay.toFixed(0)}</div>
                      </div>
                      <div>
                        <div className="text-white/20 text-[8px] tracking-wider">MONTHLY</div>
                        <div className={`font-bold text-sm ${path.monthlyUsd > 0 ? "text-emerald-400" : "text-red-400"}`}>${path.monthlyUsd.toFixed(0)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ─── PATH CARDS ─── */}
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-bold text-white">Set It & Forget It</h2>
            <p className="text-white/30 text-sm mt-1">Each card = buy once, mine forever. Total cost includes all upgrades + miners. Breakeven = cost ÷ daily profit.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-16">
            {facs.map(fac => {
              const path = allPaths.find(p => p.facility.id === fac.id);
              const isBest = path && bestPath && path.facility.id === bestPath.facility.id;
              const isActive = activePath && activePath.facility.id === fac.id;
              const canAfford = !!path;
              const expanded = selFac === fac.id;

              return (
                <div key={fac.id}
                  onClick={() => canAfford && setSelFac(expanded ? null : fac.id)}
                  className={`path-card ${isActive ? "active" : ""} ${isBest ? "best" : ""} ${!canAfford ? "opacity-20 cursor-not-allowed" : ""}
                    ${expanded ? "sm:col-span-2 md:col-span-3" : ""}`}
                  style={{ "--accent": fac.color }}
                >
                  {/* ── Compact view (always shown) ── */}
                  <div className={`flex ${expanded ? "items-start gap-6" : "flex-col"}`}>
                    <div className={expanded ? "shrink-0" : ""}>
                      {/* Level badge + name */}
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black"
                          style={{ background: `${fac.color}15`, color: fac.color, fontFamily: "'JetBrains Mono', monospace" }}>
                          {fac.lvl}
                        </div>
                        <div>
                          <div className="font-bold text-white text-sm">{fac.name}</div>
                          <div className="text-white/20 text-[9px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{fac.grid} · {fac.slots}s</div>
                        </div>
                      </div>

                      {canAfford ? (
                        <>
                          <div className="text-2xl font-extrabold text-white mb-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                            ${path.totalUsd.toFixed(0)}
                          </div>
                          <div className="text-xl font-extrabold mb-1" style={{ color: dayColor(path.breakEvenDays), fontFamily: "'JetBrains Mono', monospace" }}>
                            {fmtDays(path.breakEvenDays)}
                          </div>
                          {!isFinite(path.breakEvenDays) && path.netDayPostUsd <= 0 && (
                            <div className="text-[9px] text-red-400/60 mb-1" style={{ fontFamily: "'JetBrains Mono'" }}>
                              Unprofitable post-halving
                            </div>
                          )}
                          <div className="text-white/20 text-[9px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                            {path.count}× {path.miner.name}
                          </div>
                          {!expanded && (
                            <div className="mt-2 text-[9px] text-white/10 tracking-wider" style={{ fontFamily: "'JetBrains Mono'" }}>
                              CLICK TO EXPAND
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-white/10 text-[10px] mt-2">Need {fac.totalHcash.toLocaleString()} hCASH</div>
                      )}
                    </div>

                    {/* ── Expanded details ── */}
                    {expanded && canAfford && (
                      <div className="flex-1 min-w-0 fade-slide">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {/* Investment */}
                          <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                            <div className="text-white/30 text-[10px] tracking-widest mb-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                              TOTAL INVESTMENT
                            </div>
                            <div className="text-3xl font-extrabold text-white mb-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                              ${path.totalUsd.toFixed(0)}
                            </div>
                            <div className="flex gap-3 text-xs" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                              <span className="text-red-400/70">{path.totalAvax.toFixed(1)} AVAX</span>
                              <span className="text-white/10">·</span>
                              <span className="text-amber-300/70">{path.totalHcash.toLocaleString()} hCASH</span>
                            </div>
                            <div className="text-white/10 text-[10px] mt-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                              2 AVAX facility{fac.totalHcash > 0 ? ` + ${fac.totalHcash.toLocaleString()} upgrades` : ""} + {path.count}× {path.miner.costHcash.toLocaleString()} miners
                            </div>
                          </div>

                          {/* Build */}
                          <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                            <div className="text-white/30 text-[10px] tracking-widest mb-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>BUILD</div>
                            <div className="flex items-center gap-3 mb-3">
                              {path.miner.img && (
                                <img src={path.miner.img} alt="" className="w-12 h-12 rounded-lg object-cover"
                                  onError={e => e.target.style.display='none'} />
                              )}
                              <div>
                                <div className="text-white font-semibold">{path.count}× {path.miner.name}</div>
                                <div className="text-white/20 text-[11px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                  {path.myHash.toLocaleString()} MH/s · {path.powerUsed}W / {path.facility.powerW}W
                                </div>
                              </div>
                            </div>
                            {fac.cooldownD > 0 && (
                              <div className="text-[10px] text-white/15" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                +{fac.cooldownD}d cooldown (not in breakeven)
                              </div>
                            )}
                          </div>

                          {/* Earnings — Gross / Elec / Net breakdown */}
                          <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                            <div className="text-white/30 text-[10px] tracking-widest mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                              DAILY EARNINGS {halvingOn ? "(CURRENT → POST-HALVING)" : ""}
                            </div>
                            {/* Current rates */}
                            <div className="space-y-1.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                              <div className="flex justify-between items-center">
                                <span className="text-white/30 text-[10px]">GROSS</span>
                                <div className="text-right">
                                  <span className="text-emerald-400/70 text-sm font-bold">{path.grossDay.toFixed(1)} hCASH</span>
                                  <span className="text-white/15 text-[10px] ml-2">${(path.grossDay * px.hcashUsd).toFixed(2)}</span>
                                </div>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-white/30 text-[10px]">ELECTRICITY</span>
                                <div className="text-right">
                                  <span className="text-orange-400 text-sm font-bold">-{path.elecDay.toFixed(1)} hCASH</span>
                                  <span className="text-white/15 text-[10px] ml-2">-${(path.elecDay * px.hcashUsd).toFixed(2)}</span>
                                </div>
                              </div>
                              <div className="border-t border-white/5 pt-1.5 flex justify-between items-center">
                                <span className="text-white/50 text-[10px] font-bold">NET</span>
                                <div className="text-right">
                                  <span className={`text-lg font-bold ${path.netDay > 0 ? "text-emerald-400" : "text-red-400"}`}>{path.netDay.toFixed(1)} hCASH</span>
                                  <span className={`text-sm ml-2 font-bold ${path.netDayUsd > 0 ? "text-emerald-400" : "text-red-400"}`}>${path.netDayUsd.toFixed(2)}</span>
                                </div>
                              </div>
                            </div>

                            {/* Post-halving breakdown (only when halving toggle is ON) */}
                            {halvingOn && (
                              <div className="mt-3 pt-3 border-t border-red-500/10 space-y-1.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                <div className="text-red-400/40 text-[9px] tracking-widest mb-2">AFTER HALVING (~{HALVING_DAY}d)</div>
                                <div className="flex justify-between items-center">
                                  <span className="text-white/20 text-[10px]">GROSS</span>
                                  <span className="text-emerald-400/40 text-sm font-bold">{(path.grossDay / 2).toFixed(1)} hCASH</span>
                                </div>
                                <div className="flex justify-between items-center">
                                  <span className="text-white/20 text-[10px]">ELECTRICITY</span>
                                  <span className="text-orange-400/60 text-sm font-bold">-{path.elecDay.toFixed(1)} hCASH</span>
                                </div>
                                <div className="border-t border-white/5 pt-1.5 flex justify-between items-center">
                                  <span className="text-white/30 text-[10px] font-bold">NET</span>
                                  <span className={`text-sm font-bold ${path.netDayPost > 0 ? "text-emerald-400" : "text-red-400"}`}>
                                    {path.netDayPost.toFixed(1)} hCASH
                                    <span className="ml-2">${path.netDayPostUsd.toFixed(2)}</span>
                                  </span>
                                </div>
                                {path.netDayPost <= 0 && (
                                  <div className="text-red-400 text-[10px] font-bold mt-1">
                                    LOSING {Math.abs(path.netDayPost).toFixed(1)} hCASH/day after halving
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Monthly + Breakeven */}
                            <div className="grid grid-cols-2 gap-2 text-center mt-3 pt-3 border-t border-white/5">
                              <div>
                                <div className="text-white/20 text-[9px]">NET/MONTH</div>
                                <div className={`text-lg font-bold ${path.monthlyUsd > 0 ? "text-emerald-400" : "text-red-400"}`}>${path.monthlyUsd.toFixed(0)}</div>
                              </div>
                              <div>
                                <div className="text-white/20 text-[9px]">BREAK-EVEN</div>
                                <div className="text-sm font-bold" style={{ color: dayColor(path.breakEvenDays) }}>{fmtDays(path.breakEvenDays)}</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ─── P&L CHART ─── */}
          {activePath && (
            <div className="fade-slide rounded-2xl p-6 mb-16" style={{ background: "linear-gradient(145deg, #0f1318, #0a0d12)", border: "1px solid #1e293b" }}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-center mb-6 gap-4">
                <div className="text-center">
                  <h3 className="text-xl font-bold text-white">P&L Timeline</h3>
                  <p className="text-white/20 text-xs mt-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {activePath.facility.name} + {activePath.count}× {activePath.miner.name} · investing ${activePath.totalUsd.toFixed(0)}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setChartDays(0)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${chartDays === 0 ? "bg-white text-black" : "text-white/20 hover:text-white/40"}`}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}>AUTO</button>
                  {[30,90,180,365,730].map(d => (
                    <button key={d} onClick={() => setChartDays(d)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all
                        ${chartDays === d ? "bg-white text-black" : "text-white/20 hover:text-white/40"}`}
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >{d < 365 ? `${d}d` : `${d/365}y`}</button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="pG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={dayColor(activePath.breakEvenDays)} stopOpacity={0.15} />
                      <stop offset="100%" stopColor={dayColor(activePath.breakEvenDays)} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 8" stroke="#ffffff06" vertical={false} />
                  <XAxis dataKey="day" stroke="transparent" axisLine={false} tickLine={false}
                    tick={{ fill: "rgba(255,255,255,0.15)", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                    tickFormatter={v => v >= 365 ? `${(v/365).toFixed(1)}y` : `${v}d`} />
                  <YAxis stroke="transparent" orientation="right" axisLine={false} tickLine={false}
                    tick={{ fill: "rgba(255,255,255,0.15)", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                    tickFormatter={v => `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(0)}`} />
                  <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const pnl = payload[0]?.value ?? 0;
                    return (
                      <div className="rounded-xl px-4 py-3 shadow-2xl" style={{ background: "#0f1318", border: "1px solid #1e293b", fontFamily: "'JetBrains Mono'" }}>
                        <div className="text-white/20 text-[10px] tracking-widest mb-2">DAY {label}</div>
                        <div className={`text-lg font-bold ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}
                        </div>
                      </div>
                    );
                  }} />
                  <ReferenceLine y={0} stroke="#ffffff10" strokeWidth={1} />
                  <Area type="monotone" dataKey="pnl" stroke={dayColor(activePath.breakEvenDays)} strokeWidth={2.5} fill="url(#pG)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ─── HARDWARE TABLE ─── */}
          <div id="marketplace" className="mb-16">
            <div className="text-center mb-4">
              <h2 className="text-2xl font-bold text-white mb-2">Marketplace Listings</h2>
              <p className="text-white/30 text-sm">Live floor prices from on-chain data. Click headers to sort.</p>
            </div>

            {/* ─── BEST DAILY BUY ─── */}
            {(() => {
              const listed = miners.filter(m => m.hash > 0 && m.avail !== false && m.costHcash > 0);
              if (listed.length === 0) return null;
              const best = listed.reduce((a, b) => (a.hash / a.costHcash) > (b.hash / b.costHcash) ? a : b);
              const eff = (best.hash / best.costHcash).toFixed(3);
              return (
                <div className="mb-6 rounded-xl p-4 text-center" style={{ background: "linear-gradient(135deg, rgba(34,197,94,0.06), rgba(34,197,94,0.02))", border: "1px solid rgba(34,197,94,0.2)" }}>
                  <div className="text-[10px] text-emerald-400/60 tracking-[0.3em] mb-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    DAILY SNIPE OF THE DAY
                  </div>
                  <div className="flex items-center justify-center gap-4">
                    {best.img && <img src={best.img} alt="" className="w-12 h-12 rounded-lg object-cover" onError={e => e.target.style.display='none'} />}
                    <div className="text-left">
                      <div className="text-white font-bold text-lg">{best.name}</div>
                      <div className="text-white/30 text-xs" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                        {best.hash} MH/s · {best.powerW}W · <span className="text-amber-400">{best.costHcash.toLocaleString()} hCASH</span> (${(best.costHcash * px.hcashUsd).toFixed(0)})
                      </div>
                    </div>
                    <div className="text-right" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                      <div className="text-emerald-400 text-2xl font-bold">{eff}</div>
                      <div className="text-emerald-400/50 text-[10px] tracking-wider">MH per hCASH</div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Quick filter presets */}
            <div className="flex flex-wrap justify-center gap-2 mb-4">
              {[
                { label: "💰 Cheapest", sort: { key: "costHcash", dir: "asc" } },
                { label: "⚡ Best MH/$", sort: { key: "mhPerHcash", dir: "desc" } },
                { label: "🔋 Most Efficient (MH/W)", sort: { key: "mhw", dir: "desc" } },
                { label: "💪 Most Hashrate", sort: { key: "hash", dir: "desc" } },
              ].map(preset => (
                <button key={preset.label}
                  onClick={() => { setTableSort(preset.sort); setShowTable(true); }}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold tracking-wider transition-all border
                    ${tableSort.key === preset.sort.key
                      ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                      : "border-white/5 text-white/30 hover:text-white/50 hover:border-white/10"
                    }`}
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {preset.label}
                </button>
              ))}
            </div>
            {(() => {
              const cols = [
                { key: "", label: "", sortable: false },
                { key: "name", label: "Miner", sortable: true },
                { key: "hash", label: "MH/s", sortable: true },
                { key: "powerW", label: "Power", sortable: true },
                { key: "mhw", label: "MH/W", sortable: true },
                { key: "costHcash", label: "hCASH", sortable: true },
                { key: "avax", label: "AVAX", sortable: true },
                { key: "usd", label: "USD", sortable: true },
                { key: "mhPerHcash", label: "MH/$", sortable: true },
                { key: "profitable", label: "Profitable", sortable: true },
              ];

              const toggleSort = (key) => {
                setTableSort(prev => ({
                  key,
                  dir: prev.key === key && prev.dir === "desc" ? "asc" : "desc"
                }));
              };

              const sorted = [...miners].filter(m => m.hash > 0 && m.avail !== false).map(m => ({
                ...m,
                mhw: m.powerW > 0 ? m.hash / m.powerW * 1000 : 99999,
                mhPerHcash: m.costHcash > 0 ? m.hash / m.costHcash : 0,
                avaxPrice: m.costHcash * px.hcashAvax,
                usdPrice: m.costHcash * px.hcashUsd,
                profitable: (m.powerW > 0 ? m.hash / m.powerW * 1000 : 99999) >= 450 || m.powerW === 0,
              })).sort((a, b) => {
                const { key, dir } = tableSort;
                let av, bv;
                if (key === "name") { av = a.name; bv = b.name; return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av); }
                if (key === "avax") { av = a.avaxPrice; bv = b.avaxPrice; }
                else if (key === "usd") { av = a.usdPrice; bv = b.usdPrice; }
                else if (key === "avail") { av = a.avail ? 1 : 0; bv = b.avail ? 1 : 0; }
                else if (key === "profitable") { av = a.profitable ? 1 : 0; bv = b.profitable ? 1 : 0; }
                else { av = a[key] ?? 0; bv = b[key] ?? 0; }
                return dir === "desc" ? bv - av : av - bv;
              });

              return (
              <div className="fade-slide rounded-2xl overflow-hidden" style={{ background: "#0a0d12", border: "1px solid #1e293b" }}>
                <div className="overflow-x-auto">
                  <table className="w-full" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                        {cols.map(col => (
                          <th key={col.label}
                            onClick={() => col.sortable && toggleSort(col.key)}
                            className={`text-left text-[10px] tracking-wider font-normal py-3 px-4 ${col.sortable ? "cursor-pointer hover:text-white/60 select-none" : ""} ${tableSort.key === col.key ? "text-amber-400" : "text-white/20"}`}>
                            {col.label}
                            {tableSort.key === col.key && <span className="ml-1">{tableSort.dir === "desc" ? "▾" : "▴"}</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((m) => (
                        <tr key={m.id} className="border-t border-white/3 hover:bg-white/2 transition-colors"
                          style={{ opacity: m.profitable ? 1 : 0.35 }}>
                          <td className="py-3 px-4">
                            {m.img && <img src={m.img} alt="" className="w-8 h-8 rounded object-cover" onError={e => e.target.style.display='none'} />}
                          </td>
                          <td className="py-3 px-4 text-white font-medium text-[13px]">{m.name}</td>
                          <td className="py-3 px-4 text-white/60">{m.hash.toLocaleString()}</td>
                          <td className="py-3 px-4 text-white/40">{m.powerW > 0 ? `${m.powerW}W` : "0W"}</td>
                          <td className={`py-3 px-4 font-bold ${m.mhw >= 1000 ? "text-emerald-400" : m.mhw >= 450 ? "text-amber-400" : "text-red-400"}`}>
                            {isFinite(m.mhw) ? m.mhw.toFixed(0) : "∞"}
                          </td>
                          <td className="py-3 px-4 text-amber-300">{m.costHcash.toLocaleString()}</td>
                          <td className="py-3 px-4 text-white/40">{m.avaxPrice.toFixed(2)}</td>
                          <td className="py-3 px-4 text-white/40">${m.usdPrice.toFixed(0)}</td>
                          <td className={`py-3 px-4 font-bold ${m.mhPerHcash >= 0.1 ? "text-emerald-400" : m.mhPerHcash >= 0.05 ? "text-amber-400" : "text-white/30"}`}>
                            {m.mhPerHcash.toFixed(3)}
                          </td>
                          <td className="py-3 px-4">
                            {m.profitable
                              ? <span className="text-emerald-400 text-[10px] tracking-wider">YES</span>
                              : <span className="text-red-400 text-[10px] tracking-wider">NO</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-3 text-[10px] text-white/15 text-left" style={{ fontFamily: "'JetBrains Mono', monospace", borderTop: "1px solid rgba(255,255,255,0.03)" }}>
                  Post-halving advisory: equipment under 0.45 MH/W (450) is unprofitable below Level 5. Click any column header to sort. MH/$ = hashrate per hCASH spent (higher = better deal).
                </div>
              </div>
              );
            })()}
          </div>

          {/* ─── FACILITY PATH ─── */}
          <div className="mb-16 text-center">
            <h2 className="text-2xl font-bold text-white mb-2">The Upgrade Grind</h2>
            <p className="text-white/30 text-sm mb-6">How much it costs to reach each facility level. Level 1 = 2 AVAX, everything after is hCASH.</p>
            <div className="flex gap-1 items-end overflow-x-auto pb-2">
              {facs.map((f, i) => {
                const totalUsd = f.costAvax * px.avaxUsd + f.totalHcash * px.hcashUsd;
                const height = 40 + (i * 30);
                return (
                  <div key={f.id} className="flex-1 min-w-25">
                    <div className="rounded-t-xl p-3 text-center transition-all hover:opacity-80"
                      style={{ background: `${f.color}10`, borderTop: `2px solid ${f.color}`, height, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                      <div className="text-[10px] text-white/20 tracking-wider mb-1" style={{ fontFamily: "'JetBrains Mono'" }}>{f.grid}</div>
                      <div className="text-lg font-bold" style={{ color: f.color, fontFamily: "'JetBrains Mono'" }}>{f.name}</div>
                      <div className="text-white font-bold text-sm" style={{ fontFamily: "'JetBrains Mono'" }}>
                        ${totalUsd.toFixed(0)}
                      </div>
                      <div className="text-white/15 text-[10px]" style={{ fontFamily: "'JetBrains Mono'" }}>
                        {f.totalHcash > 0 ? `${f.totalHcash.toLocaleString()} hCASH` : "2 AVAX"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ─── NETWORK TUNE ─── */}
          <div className="rounded-xl p-4 mb-8 text-center" style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="flex flex-wrap items-center justify-center gap-6" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              <div className="flex items-center gap-3">
                <span className="text-white/20 tracking-wider text-[10px]">NETWORK</span>
                <input type="range" min={50000} max={500000} step={1000} value={netHash}
                  onChange={e => setNetHash(+e.target.value)}
                  className="slider-track w-40" style={{ height: 3 }} />
                <span className="text-white/40 min-w-20">{(netHash/1000).toFixed(0)}k MH/s</span>
              </div>
              <span className="text-white/10">·</span>
              <span className="text-white/15">Emission: {EMISSION} hCASH/block (post-halving)</span>
              <span className="text-white/10">·</span>
              <span className="text-white/10 text-[10px]">Lv6 whale = 15% @ 17k MH/s → ~113k total network</span>
            </div>
          </div>

        </div>
      ) : (
        <div className="ctr-sm px-6 py-24 text-center">
          <div className="text-6xl mb-6" style={{ fontFamily: "'JetBrains Mono'", color: "#ef4444" }}>$0</div>
          <p className="text-white/40 text-lg">
            Budget too low. Minimum entry: <span className="text-amber-400 font-bold">~2 AVAX</span> + cheapest miner
          </p>
        </div>
      )}

      {/* ═══ FOOTER ═══ */}
      <footer className="w-full border-t border-white/5 py-6 px-6 text-center">
        <div className="ctr flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[10px] text-white/15" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          <span className="text-amber-400/60 font-bold">hCASH ROI Oracle v7</span>
          <span>Chainlink + DexScreener</span>
          <span>hashcash.club</span>
          <span>Not financial advice</span>
          <span>@willisdeving · Hashathon 2026</span>
        </div>
        <p className="text-white/10 text-[10px] mt-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          Like this build? Support your dev &mdash;{' '}
          <button
            onClick={() => navigator.clipboard.writeText('0xf74D8ca88B666bd06f10614ca8ae1B8c9b43d206')}
            className="text-white/20 hover:text-amber-400/50 transition-colors cursor-pointer"
            title="Click to copy address"
            style={{ background: "none", border: "none", fontFamily: "inherit", fontSize: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}
          >
            0xf74D8...3d206
          </button>
        </p>
      </footer>
    </div>
  );
}
