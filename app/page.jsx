'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

// ─── PROTOCOL CONSTANTS ─────────────────────────────────────────────────────
const BLOCKS_DAY   = 83478; // confirmed from hcash.winstonhq.com dashboard Apr 11 2026
// HALVING ALREADY HAPPENED — emission is now 1.25 hCASH/block (confirmed from official calc Apr 4 2026)
// Next halving: ~50 days from now
const EMISSION     = 1.25;
const REFRESH_MS   = 5 * 60 * 1000;
// API key is SERVER-SIDE ONLY in /api/floors/route.js — never expose to client

// Network hash fallback — only used for ROI calc before /api/game responds.
// Prices have NO hardcoded fallback — last-known values come from localStorage only.
const DEF = { netHash: 310000 };

// NEXT_HALVING_BLOCKS is a point-in-time snapshot — do not rely on it for display.
// Live value comes from /api/game first-principles computation. Keep at 0 so the
// Halving button shows "---" rather than a stale day count before the API responds.
const NEXT_HALVING_BLOCKS = 0;
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
  // elecRate confirmed from hcash.winstonhq.com dashboard Apr 11 2026
  // Lv.1-4 from game contract, Lv.5 from dashboard (not in main contract)
  { id:"l1", lvl:1, name:"Lv.1", grid:"2×2", slots:4,  powerW:400,   elecRate:8.70, cooldownD:2,  costAvax:2, totalHcash:0,     color:"#4ade80" },
  { id:"l2", lvl:2, name:"Lv.2", grid:"2×3", slots:6,  powerW:1000,  elecRate:6.96, cooldownD:3,  costAvax:0, totalHcash:0,     color:"#22d3ee" },  // FREE upgrade
  { id:"l3", lvl:3, name:"Lv.3", grid:"3×3", slots:9,  powerW:2000,  elecRate:6.09, cooldownD:7,  costAvax:0, totalHcash:1500,  color:"#818cf8" },  // 0 + 1500
  { id:"l4", lvl:4, name:"Lv.4", grid:"3×4", slots:12, powerW:6000,  elecRate:6.96, cooldownD:14, costAvax:0, totalHcash:5500,  color:"#f472b6" },  // 0 + 1500 + 4000
  { id:"l5", lvl:5, name:"Lv.5", grid:"4×4", slots:16, powerW:15000, elecRate:3.48, cooldownD:14, costAvax:0, totalHcash:20500, color:"#fbbf24" },  // 0 + 1500 + 4000 + 15000
  { id:"l6", lvl:6, name:"Lv.6", grid:"5×5", slots:24, powerW:22500, elecRate:3.52, cooldownD:14, costAvax:0, totalHcash:45000, color:"#f43f5e", estimated:true },  // UNCONFIRMED — from @FickaelJaylor tweet, not in contract yet
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

function calcPath(facility, miner, count, netHash, hcashUsd, avaxUsd, hcashAvax, includeHalving = true, emissionRate = EMISSION, halvingDay = HALVING_DAY, blocksPerDay = BLOCKS_DAY) {
  const myHash    = count * miner.hash;
  const share     = myHash / (netHash + myHash);
  const grossDay  = blocksPerDay * emissionRate * share;
  const grossDayPost = blocksPerDay * (emissionRate / 2) * share;
  const elecDay   = (count * miner.powerW / 1000) * facility.elecRate * 24;
  const netDay    = grossDay - elecDay;
  const netDayPost = grossDayPost - elecDay;
  const netDayUsd = netDay * hcashUsd;
  const netDayPostUsd = netDayPost * hcashUsd;
  const facAvaxCost  = 2;
  const facHcashCost = facility.totalHcash;
  const minerHcash   = count * miner.costHcash;
  const totalHcash   = facHcashCost + minerHcash;
  const totalAvax    = facAvaxCost + totalHcash * hcashAvax;
  const totalUsd     = totalAvax * avaxUsd;

  let breakEvenDays;
  if (netDayUsd <= 0) {
    breakEvenDays = Infinity;
  } else if (!includeHalving) {
    breakEvenDays = totalUsd / netDayUsd;
  } else {
    const earnedBeforeHalving = netDayUsd * halvingDay;
    if (earnedBeforeHalving >= totalUsd) {
      breakEvenDays = totalUsd / netDayUsd;
    } else if (netDayPostUsd <= 0) {
      breakEvenDays = Infinity;
    } else {
      const remaining = totalUsd - earnedBeforeHalving;
      breakEvenDays = halvingDay + remaining / netDayPostUsd;
    }
  }

  return {
    facility, miner, count, myHash, share, grossDay, elecDay, netDay, netDayUsd,
    netDayPost, netDayPostUsd, includeHalving, halvingDay,
    totalHcash, totalAvax, totalUsd, breakEvenDays,
    powerUsed: count * miner.powerW, powerPct: (count * miner.powerW) / facility.powerW,
    monthlyUsd: netDayUsd * 30, yearlyUsd: netDayUsd * 365,
  };
}

function bestForFacility(fac, budgetAvax, miners, netHash, hcashUsd, avaxUsd, hcashAvax, includeHalving = true, emissionRate = EMISSION, halvingDay = HALVING_DAY, blocksPerDay = BLOCKS_DAY) {
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
    const path = calcPath(fac, m, count, netHash, hcashUsd, avaxUsd, hcashAvax, includeHalving, emissionRate, halvingDay, blocksPerDay);
    if (path.netDay <= 0) continue;
    if (!best || path.breakEvenDays < best.breakEvenDays) best = path;
  }
  return best;
}

function buildProjection(path, days) {
  if (!path) return [];
  const pts = [];
  const step = days > 365 ? 14 : days > 180 ? 7 : days > 60 ? 2 : 1;
  // Use LIVE halvingDay from the path (set by calcPath), falling back to constant
  const hDay = path.halvingDay ?? HALVING_DAY;
  for (let d = 0; d <= days; d += step) {
    let earned;
    if (!path.includeHalving || d <= hDay) {
      earned = path.netDayUsd * d;
    } else {
      earned = path.netDayUsd * hDay + path.netDayPostUsd * (d - hDay);
    }
    pts.push({ day: d, pnl: +(earned - path.totalUsd).toFixed(2), earn: +earned.toFixed(2) });
  }
  // Ensure halving day is a data point for the visible bend (only when halving enabled)
  if (path.includeHalving && hDay > 0 && hDay < days && !pts.find(p => p.day === hDay)) {
    const earnH = path.netDayUsd * hDay;
    pts.push({ day: hDay, pnl: +(earnH - path.totalUsd).toFixed(2), earn: +earnH.toFixed(2) });
    pts.sort((a, b) => a.day - b.day);
  }
  return pts;
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [px, setPx] = useState({
    hcashUsd: 0, avaxUsd: 0, hcashAvax: 0,
    ch24h: 0, vol24: 0, liq: 0, mcap: 0, loading: true, src: "loading"
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
  const [halvingBlocks, setHalvingBlocks] = useState(0);
  const [shopMiners, setShopMiners] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [liveBlocksPerDay, setLiveBlocksPerDay] = useState(BLOCKS_DAY);
  const [floorsUpdatedAt, setFloorsUpdatedAt] = useState(null);
  const [gameUpdatedAt, setGameUpdatedAt] = useState(null);
  const [floorsStale, setFloorsStale] = useState(false);
  const [gameStale, setGameStale] = useState(false);
  const [poolData, setPoolData] = useState(null);
  const [profitData, setProfitData] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const [tableSort, setTableSort] = useState({ key: "profitable", dir: "desc" });
  const [facilityFilter, setFacilityFilter] = useState(null); // null = All, number = filter miners profitable at Lv.N or lower
  const [clickedMiner, setClickedMiner] = useState(null); // tracks which side feed NFT was last clicked
  const [halvingOn, setHalvingOn] = useState(false);
  const [toast, setToast] = useState(null);
  const [dropsData, setDropsData] = useState(null);
  const [liveData, setLiveData] = useState(null);
  const prevMinersRef = useRef([]);
  const seenLiveKeysRef = useRef(new Set());

  const budgetAvax  = unit === "usd" ? budget / px.avaxUsd : budget;
  const budgetUsd   = budgetAvax * px.avaxUsd;
  // USD round-trip so the math is verifiable from displayed prices:
  // budgetHcash = (AVAX × AVAX_USD) / hCASH_USD
  // Matches what users can compute from the ticker bar. Falls back to native
  // DEX ratio only if USD prices unavailable.
  const budgetHcash = px.hcashUsd > 0
    ? budgetUsd / px.hcashUsd
    : budgetAvax / px.hcashAvax;

  // Restore last-known prices from localStorage so the page renders immediately
  // on repeat visits without waiting for Chainlink/DexScreener.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("hcash_prices") || "null");
      if (saved?.hcashUsd > 0 && saved?.avaxUsd > 0 && saved?.hcashAvax > 0) {
        setPx(prev => prev.loading
          ? { ...saved, ch24h: 0, vol24: 0, liq: 0, mcap: 0, loading: false, src: "cached" }
          : prev
        );
      }
    } catch {}
  }, []);

  // ─── Fetch prices ───
  const fetchPrices = useCallback(async () => {
    let avaxUsd = null, src = "chainlink";
    try { const cl = await getAvaxUsd(); if (cl) avaxUsd = cl; } catch {}
    let dex = null;
    try { dex = await getDex(); } catch {}

    const hcashAvax = dex?.ratio ?? null;
    const hcashUsd  = dex?.usd  ?? (hcashAvax && avaxUsd ? hcashAvax * avaxUsd : null);

    if (hcashUsd && avaxUsd && hcashAvax) {
      const live = {
        hcashUsd, avaxUsd, hcashAvax,
        ch24h: dex?.ch24h || 0, vol24: dex?.vol24 || 0, liq: dex?.liq || 0, mcap: dex?.mcap || 0,
        loading: false, src: dex ? "dex" : src,
      };
      setPx(live);
      // Persist so the next page load starts with real prices
      try { localStorage.setItem("hcash_prices", JSON.stringify({ hcashUsd, avaxUsd, hcashAvax })); } catch {}
    }
    // If fetch fails, keep whatever is already displayed (cached or still loading).
    // Never overwrite with hardcoded numbers.
  }, []);

  // ─── Fetch live marketplace floor prices ───
  const fetchFloors = useCallback(async () => {
    try {
      const res = await fetch("/api/floors");
      const data = await res.json();
      if (data.miners && data.miners.length > 0) {
        setMiners(data.miners);
        setFloorsLive(true);
        if (data.updatedAt) setFloorsUpdatedAt(new Date(data.updatedAt));
        setFloorsStale(!!data.stale);
      }
    } catch {}
  }, []);

  // ─── Fetch live game state (facilities, network, halving, shop miners) ───
  const fetchGame = useCallback(async () => {
    try {
      const res = await fetch("/api/game");
      const data = await res.json();
      if (data.network) {
        setNetHash(data.network.totalHashrate);
        setLiveEmission(data.network.emission);
        setLiveHalvingDays(data.network.halvingDays);
        setHalvingBlocks(data.network.halvingBlocks);
        if (data.network.blocksPerDay) setLiveBlocksPerDay(data.network.blocksPerDay);
        setGameLive(true);
        if (data.updatedAt) setGameUpdatedAt(new Date(data.updatedAt));
        setGameStale(!!data.stale);
      }
      if (data.facilities && data.facilities.length > 0) {
        setFacs(prev => {
          const colors = ["#4ade80","#22d3ee","#818cf8","#f472b6","#fbbf24","#f43f5e"];
          const liveFacs = data.facilities.map((f, i) => ({
            id: `l${f.lvl}`, lvl: f.lvl, name: `Lv.${f.lvl}`, grid: f.grid,
            slots: f.slots, powerW: f.powerW, elecRate: f.elecRate, cooldownD: f.cooldownD,
            costAvax: f.costAvax || 0, totalHcash: f.totalHcash || 0, color: colors[i] || "#9ca3af",
          }));
          const maxLiveLvl = Math.max(...liveFacs.map(f => f.lvl));
          const extras = prev.filter(f => f.lvl > maxLiveLvl);
          return [...liveFacs, ...extras];
        });
      }
      // ─── Shop miners: merge with marketplace data ───
      if (data.shopMiners && data.shopMiners.length > 0) {
        setShopMiners(data.shopMiners);
        setMiners(prev => {
          const merged = new Map();
          // Start with marketplace floors — preserve hcashListings, avaxListings, costAvax
          prev.forEach(m => merged.set(m.name, { ...m, marketPrice: m.costHcash, source: "secondary" }));
          // Overlay shop data — always carry factory supply info
          data.shopMiners.forEach(sm => {
            const factoryFields = {
              shopPrice: sm.costHcash,
              shopAvaxCost: sm.avaxCost,
              factoryMaxSupply: sm.maxSupply,
              factoryMinted: sm.minted,
              factoryRemaining: sm.remaining,
              factorySoldOut: sm.soldOut,
              factoryInProduction: sm.inProduction,
              components: sm.components || null,
              minerStats: sm.stats || null,
              isAssembled: !!sm.isAssembled,
              costUnknown: !!sm.costUnknown,
              assemblyFeeOnly: sm.assemblyFeeOnly ?? null,
              integrityIssues: sm.integrityIssues || null,
            };
            const existing = merged.get(sm.name);
            // Factory is a VIABLE source only if in production AND not sold out
            const factoryBuyable = sm.inProduction && !sm.soldOut && sm.costHcash > 0;
            if (!existing) {
              // New miner only in factory shop
              merged.set(sm.name, { ...sm, ...factoryFields, avail: true, marketPrice: null, source: factoryBuyable ? "factory" : "secondary" });
            } else if (factoryBuyable && sm.costHcash < (existing.costHcash ?? Infinity)) {
              // Factory buyable AND cheaper than marketplace floor
              merged.set(sm.name, { ...existing, ...factoryFields, costHcash: sm.costHcash, source: "factory", avail: true });
            } else {
              // Marketplace is cheaper OR factory sold out — keep market as primary, carry factory info
              merged.set(sm.name, { ...existing, ...factoryFields, source: "secondary" });
            }
          });
          // Dedupe by id: rename duplicates with a suffix to prevent React key collisions
          const seenIds = new Map();
          const newMiners = [...merged.values()].filter(m => m.hash > 0).map(m => {
            const baseId = m.id || `miner-${m.name?.replace(/\s+/g, "-")}`;
            const n = (seenIds.get(baseId) || 0) + 1;
            seenIds.set(baseId, n);
            return n === 1 ? { ...m, id: baseId } : { ...m, id: `${baseId}-${n}` };
          });
          // ─── Detect new drops + price drops + low supply ───
          const prevByName = new Map(prevMinersRef.current.map(m => [m.name, m]));
          const newAlerts = [];

          // On fresh loads (first poll), compare against localStorage snapshot so price
          // drops that happened since the user's last visit still fire an alert.
          let storedPriceMap = new Map();
          if (prevMinersRef.current.length === 0) {
            try {
              const snap = JSON.parse(localStorage.getItem("hcash_miner_prices") || "[]");
              storedPriceMap = new Map(snap.map(s => [s.name, s.costHcash]));
            } catch {}
          }

          newMiners.forEach(m => {
            const prev = prevByName.get(m.name);
            // A) NEW miner: name not seen in previous snapshot (skip first-ever load)
            if (!prev && prevMinersRef.current.length > 0) {
              newAlerts.push({ type: "new", name: m.name, hash: m.hash, powerW: m.powerW, cost: m.costHcash, source: m.source });
              return;
            }
            // B) PRICE DROP: hCASH cost fell 10%+ since last in-session or stored observation
            const baseline = prev ?? (storedPriceMap.has(m.name) ? { costHcash: storedPriceMap.get(m.name) } : null);
            if (baseline?.costHcash > 0 && m.costHcash > 0 && m.costHcash < baseline.costHcash * 0.9) {
              const pct = Math.round(((baseline.costHcash - m.costHcash) / baseline.costHcash) * 100);
              newAlerts.push({ type: "drop", name: m.name, hash: m.hash, powerW: m.powerW, cost: m.costHcash, prevCost: baseline.costHcash, pct, source: m.source });
            }
            if (!prev) return;
            // C) SELLING FAST: factory remaining crossed under the 10-unit threshold
            if (prev.factoryRemaining != null && m.factoryRemaining != null &&
                prev.factoryRemaining > 10 && m.factoryRemaining <= 10 && m.factoryRemaining > 0) {
              newAlerts.push({ type: "lowSupply", name: m.name, hash: m.hash, powerW: m.powerW, remaining: m.factoryRemaining, max: m.factoryMaxSupply });
            }
          });
          if (newAlerts.length > 0) setAlerts(a => [...newAlerts, ...a].slice(0, 5));
          // Persist current prices for next fresh load
          try {
            localStorage.setItem("hcash_miner_prices", JSON.stringify(
              newMiners.filter(m => m.costHcash > 0).map(m => ({ name: m.name, costHcash: m.costHcash }))
            ));
          } catch {}
          prevMinersRef.current = newMiners;
          return newMiners;
        });
      }

      // ─── New contract category detection (harnesses, crafting items, etc.) ───
      if (data.registryCategories) {
        try {
          const stored = JSON.parse(localStorage.getItem("hcash_registry_categories") || "{}");
          const hasBaseline = Object.keys(stored).length > 0;
          const catAlerts = [];
          Object.entries(data.registryCategories).forEach(([cat, items]) => {
            if (cat === "miner_nft") return; // miners handled above
            if (hasBaseline && !stored[cat]) {
              // Brand new category we've never seen
              catAlerts.push({ type: "newCategory", category: cat, items, count: items.length });
            } else if (stored[cat]) {
              // Existing category with new items added
              const newItems = items.filter(it => !stored[cat].some(s => s.id === it.id));
              if (newItems.length > 0) {
                catAlerts.push({ type: "newCategory", category: cat, items: newItems, count: newItems.length, addedTo: true });
              }
            }
          });
          if (catAlerts.length > 0) setAlerts(a => [...catAlerts, ...a].slice(0, 5));
          localStorage.setItem("hcash_registry_categories", JSON.stringify(data.registryCategories));
        } catch {}
      }
    } catch {}
  }, []);

  // ─── Fetch L1 stratum pool stats (dev net watcher) ───
  const fetchPool = useCallback(async () => {
    try {
      const res = await fetch("/api/pool");
      const data = await res.json();
      if (data.live) setPoolData(data);
      else setPoolData(null);
    } catch { setPoolData(null); }
  }, []);

  // ─── Fetch server-detected new drops (registry cron writes data/new-drops.json) ───
  const fetchDrops = useCallback(async () => {
    try {
      const res = await fetch("/api/drops");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.drops)) setDropsData(data.drops);
    } catch {}
  }, []);

  // ─── Fetch live state (watcher state, cost changes, launching, integrity) ───
  // The on-chain watcher writes these files every 5 min (faster on activity).
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch("/api/live");
      if (!res.ok) return;
      const data = await res.json();
      setLiveData(data);
    } catch {}
  }, []);

  // Convert live data into alerts: COST CHANGED / LAUNCHING / REGISTRY GAP.
  // Each item gets a stable key so we don't re-fire on every poll.
  useEffect(() => {
    if (!liveData) return;
    const seen = seenLiveKeysRef.current;
    const newAlerts = [];

    for (const c of (liveData.costChanges || []).slice(0, 5)) {
      const k = `cost:${c.kind}:${c.facilityIndex ?? c.minerIndex}:${c.detectedAt}`;
      if (seen.has(k)) continue;
      seen.add(k);
      newAlerts.push({ type: "costChange", ...c, _key: k });
    }
    for (const l of (liveData.launching || []).slice(0, 3)) {
      const k = `launch:${l.id}:${l.detectedAt}`;
      if (seen.has(k)) continue;
      seen.add(k);
      newAlerts.push({ type: "launching", ...l, _key: k });
    }
    const highSev = (liveData.integrityIssues || []).filter(i => i.severity === "high").slice(0, 3);
    for (const i of highSev) {
      const k = `integrity:${i.kind}:${i.minerId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      newAlerts.push({ type: "registryGap", ...i, _key: k });
    }

    if (newAlerts.length > 0) {
      setAlerts(prev => [...newAlerts, ...prev].slice(0, 10));
    }
  }, [liveData]);

  // When drops data or miners/shop change, inject serverDrop alerts for undismissed drops
  useEffect(() => {
    if (!dropsData || dropsData.length === 0) return;
    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem("hcash_dismissed_drops") || "[]"); } catch {}

    const active = dropsData.filter(d => !dismissed.includes(d.id));
    if (active.length === 0) return;

    const minerNames  = new Set(miners.map(m => m.name.toLowerCase()));
    const shopNames   = new Set(shopMiners.map(m => m.name.toLowerCase()));

    const dropAlerts = active.slice(0, 4).map(d => {
      const nameLc = (d.name || "").toLowerCase();
      const liveStatus = shopNames.has(nameLc) ? "live-factory"
        : minerNames.has(nameLc) ? "live-market"
        : "upcoming";
      return { type: "serverDrop", ...d, liveStatus };
    });

    setAlerts(prev => {
      const filtered = prev.filter(a => a.type !== "serverDrop");
      return [...dropAlerts, ...filtered].slice(0, 8);
    });
  }, [dropsData, miners, shopMiners]);

  // ─── Fetch profitability summary (cohort counts + top wallet) ───
  // Drives the home leaderboard banner. Cohort scan refreshes every ~12h
  // server-side via cron, so this can poll lazily.
  const fetchProfit = useCallback(async () => {
    try {
      const res = await fetch("/api/profitability");
      if (!res.ok) return;
      const data = await res.json();
      if (data.cohortCounts) setProfitData(data);
    } catch { /* leave as null — banner just won't render */ }
  }, []);

  useEffect(() => {
    fetchPrices();
    fetchFloors();
    fetchGame();
    fetchPool();
    fetchProfit();
    fetchDrops();
    fetchLive();
    // Game + floors poll every 2 min (matches server-side SWR TTL) so new drops/prices are seen quickly.
    // Prices poll every 5 min — DexScreener rate limits faster cadences.
    // Drops poll every hour — the registry cron writes every 2h, so hourly checks are sufficient.
    // Live (watcher state, cost changes, launching, integrity) polls every 60s.
    const iv  = setInterval(fetchPrices, REFRESH_MS);
    const iv2 = setInterval(fetchFloors, 2 * 60 * 1000);
    const iv3 = setInterval(fetchGame,   2 * 60 * 1000);
    const iv4 = setInterval(fetchPool,   60 * 1000);
    const iv5 = setInterval(fetchProfit, 5 * 60 * 1000);
    const iv6 = setInterval(fetchDrops,  60 * 60 * 1000);
    const iv7 = setInterval(fetchLive,   60 * 1000);
    // Tab-focus refetch: when user returns to the tab, immediately re-fetch game + floors
    // so flash sales and new drops are visible right away without waiting for the next tick.
    function onVisible() {
      if (document.visibilityState === "visible") { fetchGame(); fetchFloors(); fetchLive(); }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv); clearInterval(iv2); clearInterval(iv3); clearInterval(iv4); clearInterval(iv5); clearInterval(iv6); clearInterval(iv7);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchPrices, fetchFloors, fetchGame, fetchPool, fetchProfit, fetchDrops, fetchLive]);

  // ─── Live halving block counter (tick every ~1s) ───
  useEffect(() => {
    if (halvingBlocks <= 0) return;
    // Tick interval matches measured block time (86400 sec / blocksPerDay = ms per block)
    const msPerBlock = Math.round(86400000 / liveBlocksPerDay);
    const iv = setInterval(() => setHalvingBlocks(b => Math.max(0, b - 1)), msPerBlock);
    return () => clearInterval(iv);
  }, [halvingBlocks > 0]);

  // Clear "VIEWING" state when marketplace leaves viewport
  useEffect(() => {
    if (!clickedMiner) return;
    const mkt = document.getElementById('marketplace');
    if (!mkt) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (!entry.isIntersecting) setClickedMiner(null); },
      { threshold: 0.05 }
    );
    observer.observe(mkt);
    return () => observer.disconnect();
  }, [clickedMiner]);

  const halvingTimeStr = useMemo(() => {
    if (halvingBlocks <= 0) return "0";
    // Use live block time: total seconds = blocks * (86400 / blocksPerDay)
    const totalSec = halvingBlocks * (86400 / liveBlocksPerDay);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }, [halvingBlocks]);

  // Format "updated X ago" for timestamps
  const fmtAgo = (date) => {
    if (!date) return "";
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
    return `${Math.floor(secs/3600)}h ago`;
  };

  // ─── Compute paths ───
  const allPaths = useMemo(() => {
    // Use LIVE halvingDays from /api/game — never the stale module constant
    const liveHDay = halvingBlocks > 0 ? Math.round(halvingBlocks / liveBlocksPerDay) : liveHalvingDays;
    return facs.map(f => bestForFacility(f, budgetAvax, miners, netHash, px.hcashUsd, px.avaxUsd, px.hcashAvax, halvingOn, liveEmission, liveHDay, liveBlocksPerDay)).filter(Boolean);
  }, [budgetAvax, netHash, px, miners, halvingOn, facs, liveEmission, halvingBlocks, liveHalvingDays, liveBlocksPerDay]);

  const bestPath = allPaths.length > 0 ? allPaths.reduce((a, b) => a.breakEvenDays < b.breakEvenDays ? a : b) : null;
  const topPaths = useMemo(() => [...allPaths].sort((a, b) => a.breakEvenDays - b.breakEvenDays).slice(0, 3), [allPaths]);
  const activePath = selFac ? allPaths.find(p => p.facility.id === selFac) || bestPath : bestPath;

  // Minimum profitable facility level per miner — pure derivation, no hallucination
  // For each miner, find the lowest facility where a single miner would have positive netDay
  const minProfitLevel = useMemo(() => {
    const liveHDay = halvingBlocks > 0 ? Math.round(halvingBlocks / liveBlocksPerDay) : liveHalvingDays;
    const out = {};
    for (const m of miners) {
      if (!m.hash || m.hash <= 0) continue;
      for (const fac of facs) {
        // Single miner placement test (1 unit to determine minimum facility viability)
        const elecDay = (1 * m.powerW / 1000) * fac.elecRate * 24;
        const share = m.hash / (netHash + m.hash);
        const grossPre = BLOCKS_DAY * liveEmission * share;
        const netPre = grossPre - elecDay;
        // If halving is on, check post-halving net too; a miner is "profitable" only if its net is positive under current display mode
        const grossPost = BLOCKS_DAY * (liveEmission / 2) * share;
        const netPost = grossPost - elecDay;
        const netCheck = halvingOn ? netPost : netPre;
        if (netCheck > 0) {
          out[m.name] = fac.lvl;
          break;
        }
      }
    }
    return out;
  }, [miners, facs, netHash, liveEmission, halvingOn, halvingBlocks, liveHalvingDays]);
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

  // Show loading state until live price data arrives
  if (px.loading) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center" style={{ background: "#06080e", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap');
          @keyframes spin3d { 0% { transform: rotateY(0deg); } 100% { transform: rotateY(360deg); } }
          @keyframes pulse-ring { 0% { transform: scale(0.8); opacity: 0.5; } 50% { transform: scale(1.2); opacity: 0.2; } 100% { transform: scale(0.8); opacity: 0.5; } }
          @keyframes dots { 0%,20% { content: '.'; } 40% { content: '..'; } 60%,100% { content: '...'; } }
        `}</style>
        <div style={{ perspective: 200, marginBottom: 32 }}>
          <div style={{ fontSize: 64, animation: "spin3d 2s ease-in-out infinite" }}>⛏</div>
        </div>
        <div style={{ position: "relative", width: 80, height: 80, marginBottom: 24 }}>
          <div style={{ position: "absolute", inset: 0, border: "2px solid #fbbf2420", borderRadius: "50%", animation: "pulse-ring 2s ease infinite" }} />
          <div style={{ position: "absolute", inset: 8, border: "2px solid #fbbf2440", borderRadius: "50%", animation: "pulse-ring 2s ease infinite 0.3s" }} />
          <div style={{ position: "absolute", inset: 16, border: "2px solid #fbbf2460", borderRadius: "50%", animation: "pulse-ring 2s ease infinite 0.6s" }} />
        </div>
        <div className="text-amber-400 text-xl font-bold mb-2" style={{ fontFamily: "'Space Grotesk'" }}>hCASH ROI Oracle</div>
        <div className="text-white/30 text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          Connecting to Avalanche C-Chain
        </div>
        <div className="text-white/15 text-xs mt-4 flex flex-col items-center gap-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          <span>Chainlink oracle for AVAX/USD</span>
          <span>DexScreener for hCASH price</span>
          <span>On-chain marketplace scan</span>
          <span>Game contract state</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full text-slate-100" style={{ background: "#06080e", fontFamily: "'Space Grotesk', system-ui, sans-serif", paddingTop: halvingBlocks > 0 ? 36 : 0 }}>
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
        .side-item.clicked {
          position: relative;
          opacity: 1 !important;
          border-color: #60a5fa !important;
          background: rgba(96,165,250,0.12) !important;
          box-shadow: 0 0 16px rgba(96,165,250,0.3), inset 0 0 0 1px rgba(96,165,250,0.2);
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
        // Include ALL actively listed miners (hCASH or AVAX listings)
        const feedMiners = miners.filter(m => m.hash > 0 && (m.costHcash != null || m.costAvax != null));

        // Best deal still calculated on hCASH-denominated items (consistent currency baseline)
        const withEff = feedMiners.filter(m => m.costHcash > 0).map(m => ({ ...m, mhPerHcash: m.hash / m.costHcash }));
        const bestDealName = withEff.length > 0 ? withEff.reduce((a, b) => a.mhPerHcash > b.mhPerHcash ? a : b).name : "";
        const newestName = feedMiners.length > 0 ? feedMiners[feedMiners.length - 1].name : "";

        const SideItem = ({ m }) => {
          const isBest = m.name === bestDealName;
          const isNew = m.name === newestName;
          const isClicked = m.name === clickedMiner;
          const hasHcash = m.costHcash != null && m.costHcash > 0;
          const hasAvax  = m.costAvax != null && m.costAvax > 0;
          const primaryPrice = hasHcash ? m.costHcash.toLocaleString() : hasAvax ? m.costAvax.toFixed(2) : "—";
          const primaryUnit  = hasHcash ? "hCASH" : hasAvax ? "AVAX" : "";
          const secondary = hasHcash && hasAvax ? `or ${m.costAvax.toFixed(2)} AVAX` : null;
          const effVal = hasHcash ? (m.hash / m.costHcash).toFixed(3) : hasAvax ? (m.hash / m.costAvax).toFixed(2) : "";
          const effLabel = hasHcash ? "MH/$" : hasAvax ? "MH/AVAX" : "";
          return (
            <div className={`side-item ${isBest ? "best-deal" : ""} ${isNew && !isBest ? "newest" : ""} ${isClicked ? "clicked" : ""}`}
              onClick={(e) => {
                setClickedMiner(m.name);
                setShowTable(true);
                const clickedCard = e.currentTarget;
                clickedCard.classList.add("just-clicked");
                setTimeout(() => clickedCard.classList.remove("just-clicked"), 1200);
                // Scroll to the specific miner row in the table (by data-miner attribute)
                setTimeout(() => {
                  const row = document.querySelector(`[data-miner="${m.name.replace(/"/g, '\\"')}"]`);
                  if (row) {
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  } else {
                    document.getElementById('marketplace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }, 80);
              }}
              title="View in marketplace ↓"
              style={{ cursor: "pointer" }}>
              {m.img && <img src={m.img} alt="" style={{ width: 48, height: 48, borderRadius: 8, margin: '0 auto 6px', objectFit: 'cover' }} onError={e => e.target.style.display='none'} />}
              <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2, lineHeight: 1.3 }}>{m.name}</div>
              <div style={{ fontSize: 14, color: '#fbbf24', fontWeight: 700 }}>{primaryPrice}</div>
              <div style={{ fontSize: 9, color: '#4b5563' }}>{primaryUnit}</div>
              {secondary && <div style={{ fontSize: 8, color: '#4b5563', marginTop: 1 }}>{secondary}</div>}
              <div style={{ fontSize: 9, color: '#6b7280', marginTop: 3 }}>{m.hash} MH/s · {m.powerW}W</div>
              {effVal && <div style={{ fontSize: 9, color: isBest ? '#22c55e' : '#374151', marginTop: 2 }}>{effVal} {effLabel}</div>}
            </div>
          );
        };

        return (
        <>
          <div className="side-feed side-feed-left">
            <div className="side-feed-inner">
              {[...feedMiners, ...feedMiners].map((m, i) => <SideItem key={`l${i}`} m={m} />)}
            </div>
          </div>
          <div className="side-feed side-feed-right">
            <div className="side-feed-inner">
              {[...feedMiners].reverse().concat([...feedMiners].reverse()).map((m, i) => <SideItem key={`r${i}`} m={m} />)}
            </div>
          </div>
        </>
        );
      })()}

      {/* ═══ FIXED HALVING COUNTER ═══ */}
      {halvingBlocks > 0 && (
        <div className="fixed top-0 left-0 right-0 z-50 border-b" style={{
          background: liveHalvingDays < 14 ? "rgba(239,68,68,0.08)" : liveHalvingDays < 30 ? "rgba(234,179,8,0.06)" : "rgba(255,255,255,0.02)",
          borderColor: liveHalvingDays < 14 ? "rgba(239,68,68,0.2)" : liveHalvingDays < 30 ? "rgba(234,179,8,0.15)" : "rgba(255,255,255,0.05)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        }}>
          <div className="ctr flex items-center justify-center gap-4 py-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            <span className={`text-[10px] tracking-[0.3em] font-bold ${liveHalvingDays < 14 ? "text-red-400" : liveHalvingDays < 30 ? "text-amber-400" : "text-white/30"}`}>
              HALVING
            </span>
            <span className={`text-lg font-bold tabular-nums ${liveHalvingDays < 14 ? "text-red-400" : liveHalvingDays < 30 ? "text-amber-400" : "text-white/70"}`}>
              {halvingBlocks.toLocaleString()}
            </span>
            <span className={`text-[10px] ${liveHalvingDays < 14 ? "text-red-400/50" : "text-white/20"}`}>BLOCKS</span>
            <span className="text-white/10">|</span>
            <span className={`text-sm font-bold ${liveHalvingDays < 14 ? "text-red-400" : liveHalvingDays < 30 ? "text-amber-400" : "text-white/50"}`}>
              {halvingTimeStr}
            </span>
            <span className="text-white/10">|</span>
            <span className="text-white/20 text-[10px]">{liveEmission} → {(liveEmission/2).toFixed(3)}</span>
          </div>
        </div>
      )}

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
          <div className="flex items-center gap-2" title={floorsStale ? `Marketplace data stale — RPC degraded, serving last good ${floorsUpdatedAt ? fmtAgo(floorsUpdatedAt) : ""}` : (floorsUpdatedAt ? `Marketplace updated ${fmtAgo(floorsUpdatedAt)}` : "")}>
            <div className={`w-1.5 h-1.5 rounded-full ${!floorsLive ? "bg-amber-400 glow" : floorsStale ? "bg-amber-400 glow" : "bg-cyan-400"}`} />
            <span className={floorsStale ? "text-amber-400/70" : "text-white/20"}>{floorsLive ? `${miners.length} miners${floorsUpdatedAt ? ` · ${fmtAgo(floorsUpdatedAt)}` : ""}${floorsStale ? " · STALE" : ""}` : "loading..."}</span>
          </div>
          <div className="flex items-center gap-2" title={gameStale ? `Game state stale — RPC degraded, serving last good ${gameUpdatedAt ? fmtAgo(gameUpdatedAt) : ""}` : (gameUpdatedAt ? `Game state updated ${fmtAgo(gameUpdatedAt)}` : "")}>
            <div className={`w-1.5 h-1.5 rounded-full ${!gameLive ? "bg-amber-400 glow" : gameStale ? "bg-amber-400 glow" : "bg-emerald-400"}`} />
            <span className={gameStale ? "text-amber-400/70" : "text-white/20"}>{gameLive ? `${facs.length} facs${gameUpdatedAt ? ` · ${fmtAgo(gameUpdatedAt)}` : ""}${gameStale ? " · STALE" : ""}` : "loading game..."}</span>
          </div>
          {poolData && (
            <div className="flex items-center gap-2" title={`L1 stratum pool · ${poolData.uniqueMiners} unique miners · updated ${fmtAgo(new Date(poolData.updatedAt))}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
              <span className="text-purple-400/60 tracking-wider">L1 DEV</span>
              <span className="text-white/20">{poolData.blockHeight.toLocaleString()} blocks · {poolData.activeMiners} online</span>
            </div>
          )}
          <span className="text-white/10">|</span>
          <a href="/profitability"
            className="text-emerald-400/70 hover:text-emerald-400 transition-colors cursor-pointer tracking-wider">PROFITABILITY</a>
          <a href="#marketplace" onClick={(e) => { e.preventDefault(); setShowTable(true); document.getElementById('marketplace')?.scrollIntoView({ behavior: 'smooth' }); }}
            className="text-cyan-400/60 hover:text-cyan-400 transition-colors cursor-pointer tracking-wider">MARKETPLACE</a>
        </div>
      </div>

      {/* ═══ ALERT BANNER (new drops / price changes) ═══ */}
      {alerts.length > 0 && (() => {
        const a = alerts[0];
        // Each alert type gets its own color palette
        const palette = a.type === "drop"
          ? { border: "rgba(251,191,36,0.2)", bg: "rgba(251,191,36,0.05)", label: "text-amber-400", title: "PRICE DROP" }
          : a.type === "lowSupply"
          ? { border: "rgba(251,191,36,0.2)", bg: "rgba(251,191,36,0.05)", label: "text-amber-400", title: "SELLING FAST" }
          : a.type === "newCategory"
          ? { border: "rgba(167,139,250,0.3)", bg: "rgba(167,139,250,0.05)", label: "text-violet-400", title: "NEW IN SHOP" }
          : a.type === "serverDrop" && a.liveStatus !== "upcoming"
          ? { border: "rgba(34,197,94,0.25)", bg: "rgba(34,197,94,0.06)", label: "text-emerald-400", title: "NEW DROP · LIVE" }
          : a.type === "serverDrop"
          ? { border: "rgba(96,165,250,0.25)", bg: "rgba(96,165,250,0.05)", label: "text-blue-400", title: "UPCOMING DROP" }
          : a.type === "launching"
          ? { border: "rgba(249,115,22,0.3)", bg: "rgba(249,115,22,0.06)", label: "text-orange-400", title: "LAUNCHING NOW" }
          : a.type === "costChange"
          ? { border: "rgba(34,211,238,0.25)", bg: "rgba(34,211,238,0.05)", label: "text-cyan-400", title: "GAME RULES CHANGED" }
          : a.type === "registryGap"
          ? { border: "rgba(234,179,8,0.3)", bg: "rgba(234,179,8,0.05)", label: "text-yellow-400", title: "REGISTRY GAP" }
          : { border: "rgba(34,197,94,0.2)", bg: "rgba(34,197,94,0.04)", label: "text-emerald-400", title: "NEW DROP" };
        return (
          <div className="w-full border-b" style={{ background: palette.bg, borderColor: palette.border }}>
            <div className="ctr py-2 flex items-center justify-center gap-3 flex-wrap" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              <span className={`${palette.label} font-bold text-xs tracking-wider`}>{palette.title}</span>
              {a.type === "drop" ? (
                <>
                  <span className="text-white/60">{a.name} — {a.hash} MH/s · {a.powerW}W</span>
                  <span className="text-white/40">{a.prevCost.toLocaleString()}</span>
                  <span className="text-white/30">→</span>
                  <span className="text-amber-400 font-bold">{a.cost.toLocaleString()} hCASH</span>
                  <span className="text-amber-400 text-[10px]">-{a.pct}%</span>
                </>
              ) : a.type === "lowSupply" ? (
                <span className="text-white/60">{a.name} — only {a.remaining} of {a.max} left in factory</span>
              ) : a.type === "newCategory" ? (
                <>
                  <span className="text-violet-300/80">
                    {a.addedTo ? `${a.count} new item${a.count > 1 ? "s" : ""} added to` : "New category:"}{" "}
                    <span className="font-semibold">{a.category.replace(/_/g, " ")}</span>
                  </span>
                  {a.items?.slice(0, 3).map(it => (
                    <span key={it.id} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">{it.name}</span>
                  ))}
                  {a.items?.length > 3 && <span className="text-violet-400/50 text-[10px]">+{a.items.length - 3} more</span>}
                </>
              ) : a.type === "launching" ? (
                <>
                  <span className="text-white/60">{a.name}</span>
                  <span className="text-white/40">{a.hashrateMhps?.toLocaleString?.()} MH/s · {a.powerWatts}W</span>
                  <span className="text-orange-400/80 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(249,115,22,0.12)" }}>contract live · 0 minted</span>
                </>
              ) : a.type === "costChange" ? (
                <>
                  <span className="text-white/60">{a.label || `${a.kind}: ${a.facilityIndex ?? a.minerIndex}`}</span>
                  {a.kind === "facility_cost" && (
                    <span className="text-white/40">
                      {a.oldHcash?.toLocaleString()} → <span className="text-emerald-400 font-bold">{a.newHcash === 0 ? "FREE" : `${a.newHcash.toLocaleString()} hCASH`}</span>
                    </span>
                  )}
                  {a.kind === "miner_cost_hcash" && (
                    <span className="text-white/40">Miner #{a.minerIndex}: {a.oldHcash?.toLocaleString()} → {a.newHcash?.toLocaleString()} hCASH</span>
                  )}
                  {a.kind === "miner_cost_avax" && (
                    <span className="text-white/40">Miner #{a.minerIndex}: {a.oldAvax} → {a.newAvax} AVAX</span>
                  )}
                </>
              ) : a.type === "registryGap" ? (
                <>
                  <span className="text-yellow-200/80 font-bold text-xs">{a.kind?.replace(/_/g, " ").toLowerCase()}</span>
                  <span className="text-white/50 text-[11px]">{a.detail}</span>
                </>
              ) : a.type === "serverDrop" ? (
                <>
                  <span className="text-white/60">{a.name}</span>
                  {(a.hashrateMhps > 0 || a.powerWatts > 0) && (
                    <span className="text-white/40">{a.hashrateMhps?.toLocaleString?.()} MH/s · {a.powerWatts}W</span>
                  )}
                  {a.efficiency > 0 && (
                    <span className="text-white/30">{a.efficiency.toFixed(2)} MH/W</span>
                  )}
                  {a.components && (
                    <span className="text-orange-400/70 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(249,115,22,0.10)" }}>ASSEMBLED RIG</span>
                  )}
                  {a.category && a.category !== "miner_nft" && (
                    <span className="text-white/30 text-[10px]">{a.category.replace(/_/g, " ")}</span>
                  )}
                  <span className="text-white/20 text-[10px]">detected {fmtAgo(new Date(a.detectedAt))}</span>
                </>
              ) : (
                <>
                  <span className="text-white/60">{a.name} — {a.hash} MH/s · {a.powerW}W · {a.cost?.toLocaleString?.() ?? a.cost} hCASH</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded ${a.source === "factory" ? "bg-emerald-500/15 text-emerald-400" : "bg-cyan-500/15 text-cyan-400"}`}>
                    {a.source === "factory" ? "FACTORY" : "SECONDARY"}
                  </span>
                </>
              )}
              <button onClick={() => {
                if (alerts[0]?.type === "serverDrop" && alerts[0]?.id) {
                  try {
                    const dismissed = JSON.parse(localStorage.getItem("hcash_dismissed_drops") || "[]");
                    if (!dismissed.includes(alerts[0].id)) {
                      localStorage.setItem("hcash_dismissed_drops", JSON.stringify([...dismissed, alerts[0].id].slice(-50)));
                    }
                  } catch {}
                }
                setAlerts(prev => prev.slice(1));
              }} className="text-white/20 hover:text-white/40 ml-2" style={{ background: "none", border: "none", cursor: "pointer" }}>✕</button>
            </div>
          </div>
        );
      })()}

      {/* ═══ HERO ═══ */}
      <div className="relative w-full">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-50 left-1/2 -translate-x-1/2 w-250 h-150 rounded-full"
            style={{ background: "radial-gradient(ellipse, rgba(234,179,8,0.04) 0%, transparent 70%)" }} />
        </div>

        <div className="relative ctr px-6 pt-16 pb-8">
          {/* Split hero: input left, result preview right (mobile: stacked) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center">

            {/* ─── LEFT: Input column ─── */}
            <div className="text-center md:text-left">
              <div className="mb-8">
                <h1 className="text-3xl sm:text-5xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-4">
                  <span className="text-amber-400">What</span> it really costs<span className="text-white/20">.</span>
                </h1>
                <p className="text-white/40 text-base md:text-lg">
                  The unfiltered truth about hCASH mining ROI.
                  Drag the slider. See the math. No BS.
                </p>
              </div>

              {/* Unit toggle */}
              <div className="flex justify-center md:justify-start gap-2 mb-6">
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
                <div className="text-4xl sm:text-5xl md:text-5xl lg:text-6xl font-extrabold tracking-tighter" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {unit === "usd" && "$"}{budget.toLocaleString()}
                  {unit === "avax" && <span className="text-3xl text-amber-400 ml-2 font-bold">AVAX</span>}
                </div>
                <div className="mt-3 flex flex-wrap justify-center md:justify-start gap-2 sm:gap-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
              <div className="px-2">
                <input type="range" className="slider-track"
                  min={unit === "usd" ? 10 : 2} max={unit === "usd" ? 9000 : 1000}
                  step={unit === "usd" ? 5 : 1} value={budget}
                  onChange={e => setBudget(+e.target.value)} />
                <div className="flex justify-between mt-3 text-[10px] tracking-wider text-white/20" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  <span>{unit === "usd" ? "$10" : "2 AVAX"}</span>
                  <span className="text-white/10">▲ SLIDE ▲</span>
                  <span>{unit === "usd" ? "$9,000" : "1,000 AVAX"}</span>
                </div>

                {/* Whale + Halving toggles row */}
                <div className="flex flex-wrap justify-center md:justify-start gap-2 mt-4">
                  <button onClick={() => { setUnit("avax"); setBudget(5000); }}
                    className="px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all text-white/20 border border-white/5 hover:border-amber-500/30 hover:text-amber-400"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    🐋 WHALE (5K)
                  </button>
                  <button onClick={() => setHalvingOn(false)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all border
                      ${!halvingOn ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400" : "text-white/20 border-white/5 hover:text-white/40"}`}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    Current
                  </button>
                  <button onClick={() => setHalvingOn(true)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider transition-all border
                      ${halvingOn ? "bg-red-500/15 border-red-500/30 text-red-400" : "text-white/20 border-white/5 hover:text-white/40"}`}
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    Halving ({gameLive ? `~${liveHalvingDays.toFixed(1)}d` : "---"})
                  </button>
                </div>
              </div>
            </div>

            {/* ─── RIGHT: Live Breakeven Preview ─── */}
            <div className="fade-slide">
              {bestPath ? (
                <div className="rounded-2xl p-6" style={{
                  background: "linear-gradient(145deg, rgba(251,191,36,0.06), rgba(251,191,36,0.02))",
                  border: "1px solid rgba(251,191,36,0.2)",
                }}>
                  <div className="text-[10px] text-amber-400/60 tracking-[0.3em] mb-3 text-center md:text-left" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    BEST PATH TO BREAKEVEN AT {unit === "usd" ? `$${budget.toLocaleString()}` : `${budget.toLocaleString()} AVAX`}
                    {halvingOn && <span className="text-red-400/60"> · WITH HALVING</span>}
                    {px.src === "default" && <span className="text-white/20 ml-2">· EST PRICES</span>}
                  </div>
                  <div className="text-5xl md:text-6xl font-extrabold tracking-tight mb-2 text-center md:text-left"
                    style={{ color: dayColor(bestPath.breakEvenDays), fontFamily: "'JetBrains Mono', monospace" }}>
                    {fmtDays(bestPath.breakEvenDays)}
                  </div>
                  <div className="text-white/50 text-sm mb-5 text-center md:text-left" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {bestPath.facility.name} + {bestPath.count}× {bestPath.miner.name}
                    <div className="text-white/20 text-[11px] mt-1">
                      {bestPath.myHash.toLocaleString()} MH/s · {(bestPath.powerUsed/1000).toFixed(1)}kW
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
                      <div className="text-white/30 text-[9px] tracking-widest mb-1">INVEST</div>
                      <div className="text-white font-bold text-lg">${bestPath.totalUsd.toFixed(0)}</div>
                      <div className="text-white/20 text-[10px]">{bestPath.totalAvax.toFixed(1)} AVAX</div>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
                      <div className="text-white/30 text-[9px] tracking-widest mb-1">DAILY NET</div>
                      <div className={`font-bold text-lg ${bestPath.netDayUsd > 0 ? "text-emerald-400" : "text-red-400"}`}>${bestPath.netDayUsd.toFixed(2)}</div>
                      <div className="text-white/20 text-[10px]">{bestPath.netDay.toFixed(1)} hCASH</div>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
                      <div className="text-white/30 text-[9px] tracking-widest mb-1">MONTHLY</div>
                      <div className={`font-bold text-lg ${bestPath.monthlyUsd > 0 ? "text-emerald-400" : "text-red-400"}`}>${bestPath.monthlyUsd.toFixed(0)}</div>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
                      <div className="text-white/30 text-[9px] tracking-widest mb-1">HASHRATE</div>
                      <div className="text-white font-bold text-lg">{bestPath.myHash.toLocaleString()}</div>
                      <div className="text-white/20 text-[10px]">MH/s</div>
                    </div>
                  </div>

                  <div className="text-white/20 text-[10px] text-center mt-4 tracking-wider" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    See all paths below ↓
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl p-6 text-center" style={{
                  background: "rgba(239,68,68,0.04)",
                  border: "1px solid rgba(239,68,68,0.2)",
                }}>
                  <div className="text-[10px] text-red-400/60 tracking-[0.3em] mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    BUDGET TOO LOW
                  </div>
                  <div className="text-3xl font-bold text-red-400 mb-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    No viable path
                  </div>
                  <div className="text-white/40 text-sm">
                    Minimum entry: 2 AVAX + at least one profitable miner.<br />
                    Drag the slider higher to see options.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Network + halving indicator — full width below grid */}
          <div className="text-center mt-8 text-[10px] text-white/15" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {gameLive && <span className="text-emerald-400/40 mr-1">LIVE</span>}
            Network: {(netHash/1000).toFixed(0)}k MH/s · Emission: {liveEmission} hCASH/block ·{" "}
            {halvingBlocks > 0 ? (
              <span className={`${liveHalvingDays < 14 ? "text-red-400/70" : liveHalvingDays < 30 ? "text-amber-400/70" : "text-amber-400/50"}`}>
                Halving: {halvingBlocks.toLocaleString()} blocks · {halvingTimeStr} · {liveEmission} &rarr; {(liveEmission/2).toFixed(3)}/block
              </span>
            ) : (
              <span className="text-amber-400/50">Halving in ~{liveHalvingDays}d</span>
            )}
          </div>
        </div>
      </div>

      {/* ═══ LEADERBOARD TEASER ═══ */}
      {profitData && profitData.cohortCounts && (
        <div className="w-full ctr px-6 mb-8">
          <a href="/profitability"
             className="block group rounded-2xl p-5 transition-all hover:-translate-y-0.5"
             style={{
               background: "linear-gradient(135deg, rgba(34,197,94,0.06), rgba(34,197,94,0.02))",
               border: "1px solid rgba(34,197,94,0.20)",
             }}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-5">
                <div>
                  <div className="text-[10px] tracking-[0.3em] text-emerald-400/60 mb-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    LIVE LEADERBOARD
                  </div>
                  <div className="text-white text-base md:text-lg font-bold">
                    <span className="text-emerald-400 tabular-nums" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                      {(((profitData.cohortCounts.realized_profit || 0) + (profitData.cohortCounts.paper_profit || 0)) * 100 / Math.max(profitData.walletsTotal, 1)).toFixed(0)}%
                    </span> of {profitData.walletsTotal.toLocaleString()} players in profit
                  </div>
                </div>
                <span className="hidden md:inline text-white/10">|</span>
                <div className="text-white/40 text-xs hidden md:block" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {(profitData.cohortCounts.realized_profit || 0).toLocaleString()} realized ·{" "}
                  {(profitData.cohortCounts.paper_profit || 0).toLocaleString()} paper ·{" "}
                  {(profitData.cohortCounts.underwater || 0).toLocaleString()} underwater
                </div>
              </div>
              <div className="flex items-center gap-2 text-emerald-400/80 group-hover:text-emerald-400 text-xs tracking-wider"
                   style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                SEE WHO + ON-CHAIN PROOF{" "}
                <span className="transition-transform group-hover:translate-x-0.5">→</span>
              </div>
            </div>
          </a>
        </div>
      )}

      {/* ═══ RESULTS ═══ */}
      {allPaths.length > 0 ? (
        <div className="w-full ctr px-6 pb-20">

          {/* ─── TOP ROI PICKS ─── */}
          {topPaths.length > 0 && (
            <div className="fade-slide mb-10">
              <div className="text-center mb-6">
                <div className="text-white/20 text-xs tracking-[0.3em] mb-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  TOP {topPaths.length} FASTEST ROI AT {budgetAvax.toFixed(0)} AVAX {halvingOn && <span className="text-red-400/60">· HALVING IN ~{liveHalvingDays}d</span>}
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
                          <div className="font-bold text-white text-sm">{fac.name}{fac.estimated && <span className="text-[8px] text-amber-400/50 ml-1 font-normal tracking-wider">EST</span>}</div>
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
                                <div className="text-red-400/40 text-[9px] tracking-widest mb-2">AFTER HALVING (~{liveHalvingDays}d)</div>
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

            {/* Coming Soon: 1-Click Buy + List teaser — OpenSea blue palette */}
            <div className="mb-6 rounded-xl p-5 relative overflow-hidden"
              style={{
                background: "linear-gradient(135deg, rgba(32,129,226,0.10), rgba(32,129,226,0.04))",
                border: "1px solid rgba(32,129,226,0.30)",
              }}>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] tracking-[0.3em] font-bold px-2 py-1 rounded"
                    style={{ background: "rgba(32,129,226,0.20)", color: "#5fa8f5", fontFamily: "'JetBrains Mono', monospace" }}>
                    COMING SOON
                  </span>
                  <div>
                    <div className="text-white font-bold text-lg">1-Click Buy & List — direct on-chain</div>
                    <div className="text-white/50 text-sm" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                      Connect wallet · trade hCASH NFTs without leaving this page · same contract, better UX
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button disabled
                    className="px-4 py-2 rounded-lg text-xs font-bold tracking-wider opacity-70 cursor-not-allowed"
                    style={{ background: "rgba(32,129,226,0.18)", color: "#7cb8f7", border: "1px solid rgba(32,129,226,0.40)", fontFamily: "'JetBrains Mono', monospace" }}>
                    BUY · soon
                  </button>
                  <button disabled
                    className="px-4 py-2 rounded-lg text-xs font-bold tracking-wider opacity-70 cursor-not-allowed"
                    style={{ background: "rgba(32,129,226,0.18)", color: "#7cb8f7", border: "1px solid rgba(32,129,226,0.40)", fontFamily: "'JetBrains Mono', monospace" }}>
                    LIST · soon
                  </button>
                </div>
              </div>
              <div className="text-[10px] text-white/30 mt-3" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                Reads + writes the same Thirdweb marketplace contract used by hashcash.club. Non-custodial. Zero fees from us.
              </div>
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
                      <div className="text-white/20 text-[10px] mt-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                        {best.hcashListings > 0 && <span>{best.hcashListings} hCASH listing{best.hcashListings > 1 ? "s" : ""}</span>}
                        {best.hcashListings > 0 && best.avaxListings > 0 && <span> · </span>}
                        {best.avaxListings > 0 && <span>{best.avaxListings} AVAX listing{best.avaxListings > 1 ? "s" : ""}</span>}
                        {best.factoryRemaining > 0 && best.factoryRemaining < best.factoryMaxSupply && (
                          <span className="text-emerald-400/60"> · Factory: {best.factoryRemaining} left</span>
                        )}
                        {minProfitLevel[best.name] && (
                          <span className="text-amber-400/50"> · Profitable Lv.{minProfitLevel[best.name]}+</span>
                        )}
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

            {/* Facility level filter — scope table to miners profitable at user's facility */}
            <div className="flex flex-wrap justify-center items-center gap-2 mb-3">
              <span className="text-white/30 text-[10px] tracking-wider mr-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>FILTER BY YOUR FACILITY:</span>
              {[
                { label: "All", value: null },
                { label: "Lv.1", value: 1 },
                { label: "Lv.2", value: 2 },
                { label: "Lv.3", value: 3 },
                { label: "Lv.4", value: 4 },
                { label: "Lv.5", value: 5 },
              ].map(chip => (
                <button key={chip.label}
                  onClick={() => setFacilityFilter(chip.value)}
                  className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wider transition-all border
                    ${facilityFilter === chip.value
                      ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400"
                      : "border-white/5 text-white/30 hover:text-white/50 hover:border-white/10"
                    }`}
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {chip.label}
                </button>
              ))}
            </div>

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
                { key: "source", label: "Source", sortable: true },
                { key: "profitable", label: "Profitable", sortable: true },
              ];

              const toggleSort = (key) => {
                setTableSort(prev => ({
                  key,
                  dir: prev.key === key && prev.dir === "desc" ? "asc" : "desc"
                }));
              };

              const sorted = [...miners].filter(m => {
                if (!(m.hash > 0 && m.avail !== false)) return false;
                if (facilityFilter === null) return true;
                const lvl = minProfitLevel[m.name];
                return lvl && lvl <= facilityFilter;
              }).map(m => ({
                ...m,
                mhw: m.powerW > 0 ? m.hash / m.powerW : 99999,
                mhPerHcash: m.costHcash > 0 ? m.hash / m.costHcash : 0,
                avaxPrice: m.costHcash * px.hcashAvax,
                usdPrice: m.costHcash * px.hcashUsd,
                profitable: (m.powerW > 0 ? m.hash / m.powerW : 99999) >= 0.45 || m.powerW === 0,
              })).sort((a, b) => {
                const { key, dir } = tableSort;
                let av, bv;
                if (key === "name") { av = a.name; bv = b.name; return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av); }
                if (key === "avax") { av = a.avaxPrice; bv = b.avaxPrice; }
                else if (key === "usd") { av = a.usdPrice; bv = b.usdPrice; }
                else if (key === "source") { av = a.source === "factory" ? 1 : 0; bv = b.source === "factory" ? 1 : 0; }
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
                      {sorted.map((m, i) => (
                        <tr key={`${m.id || m.name}-${i}`}
                          data-miner={m.name}
                          className={`border-t transition-colors cursor-pointer ${clickedMiner === m.name ? "bg-blue-500/15 border-blue-400/40" : "border-white/5 hover:bg-white/5"}`}
                          style={{ opacity: m.profitable ? 1 : 0.35, boxShadow: clickedMiner === m.name ? "inset 3px 0 0 #60a5fa" : "none" }}
                          onClick={() => setClickedMiner(m.name)}
                          title="Click to highlight — buy/list flow coming soon">
                          <td className="py-3 px-4">
                            {m.img && <img src={m.img} alt="" className="w-8 h-8 rounded object-cover" onError={e => e.target.style.display='none'} />}
                          </td>
                          <td className="py-3 px-4 text-white font-medium text-[13px]">{m.name}</td>
                          <td className="py-3 px-4 text-white/60">{m.hash.toLocaleString()}</td>
                          <td className="py-3 px-4 text-white/40">{m.powerW > 0 ? `${m.powerW}W` : "0W"}</td>
                          <td className={`py-3 px-4 font-bold ${m.mhw >= 1.0 ? "text-emerald-400" : m.mhw >= 0.45 ? "text-amber-400" : "text-red-400"}`}>
                            {isFinite(m.mhw) ? m.mhw.toFixed(3) : "∞"}
                          </td>
                          <td className="py-3 px-4">
                            {m.costUnknown ? (
                              <>
                                <div className="text-yellow-400/80 text-[11px]" title={m.integrityIssues?.[0]?.detail || "Cost cannot be computed — registry gap"}>
                                  cost incomplete
                                </div>
                                <div className="text-[9px] text-yellow-400/60 mt-0.5" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                  REGISTRY GAP
                                </div>
                                {m.assemblyFeeOnly != null && (
                                  <div className="text-[9px] text-white/30 mt-0.5">+{m.assemblyFeeOnly.toLocaleString()} asm fee</div>
                                )}
                              </>
                            ) : (
                              <>
                                <div className="text-amber-300">{m.costHcash != null ? m.costHcash.toLocaleString() : "—"}</div>
                                {m.hcashListings > 0 && <div className="text-white/20 text-[9px]">{m.hcashListings} listing{m.hcashListings > 1 ? "s" : ""}</div>}
                              </>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <div className="text-white/40">{m.costAvax != null ? m.costAvax.toFixed(2) : m.avaxPrice.toFixed(2)}</div>
                            {m.avaxListings > 0 && <div className="text-white/20 text-[9px]">{m.avaxListings} AVAX list{m.avaxListings > 1 ? "s" : ""}</div>}
                          </td>
                          <td className="py-3 px-4 text-white/40">${m.usdPrice.toFixed(0)}</td>
                          <td className={`py-3 px-4 font-bold ${m.mhPerHcash >= 0.1 ? "text-emerald-400" : m.mhPerHcash >= 0.05 ? "text-amber-400" : "text-white/30"}`}>
                            {m.mhPerHcash.toFixed(3)}
                          </td>
                          <td className="py-3 px-4">
                            {/* Primary source badge — tight one-word badge */}
                            <span className={`inline-block text-[10px] tracking-wider px-2 py-0.5 rounded whitespace-nowrap ${m.source === "factory" ? "bg-emerald-500/15 text-emerald-400" : "bg-cyan-500/15 text-cyan-400"}`}>
                              {m.source === "factory" ? "FACTORY" : "SECONDARY"}
                            </span>
                            {/* Count line — factory remaining OR secondary listing count */}
                            <div className="text-[9px] mt-1 whitespace-nowrap" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                              {m.source === "factory" && m.factoryRemaining > 0 && (
                                <span className="text-emerald-400/70">{m.factoryRemaining} left</span>
                              )}
                              {m.source === "secondary" && (m.hcashListings || m.avaxListings) > 0 && (
                                <span className="text-cyan-400/70">{(m.hcashListings||0) + (m.avaxListings||0)} listing{(m.hcashListings||0) + (m.avaxListings||0) > 1 ? "s" : ""}</span>
                              )}
                            </div>
                            {/* Secondary hint: factory status when not primary source */}
                            {m.source === "secondary" && m.factoryMaxSupply > 0 && (
                              <div className="text-[9px] mt-1 text-white/25" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                {m.factorySoldOut
                                  ? "Factory: sold out"
                                  : `Factory: ${m.factoryRemaining}/${m.factoryMaxSupply} left`
                                }
                              </div>
                            )}
                            {/* Secondary hint: marketplace listings when factory is primary */}
                            {m.source === "factory" && ((m.hcashListings || 0) + (m.avaxListings || 0)) > 0 && (
                              <div className="text-[9px] mt-1 text-white/25" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                Also: {(m.hcashListings||0) + (m.avaxListings||0)} secondary
                              </div>
                            )}
                            {minProfitLevel[m.name] && (
                              <div className="text-[9px] mt-1 text-amber-400/50" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                                Profitable Lv.{minProfitLevel[m.name]}+
                              </div>
                            )}
                            <a
                              href="https://hashcash.club/market?ref=0xf74D8ca88B666bd06f10614ca8ae1B8c9b43d206"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-block text-[9px] mt-1 text-white/25 hover:text-cyan-400 transition-colors tracking-wider"
                              style={{ fontFamily: "'JetBrains Mono', monospace" }}
                              title="Verify this listing on hashcash.club marketplace"
                            >
                              verify ↗
                            </a>
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
                {sorted.length === 0 && facilityFilter !== null && (
                  <div className="py-8 text-center" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    <div className="text-white/40 text-sm mb-2">No miners profitable at Lv.{facilityFilter}{halvingOn ? " with halving on" : ""}</div>
                    <div className="text-white/20 text-xs">Try a higher facility level{halvingOn ? ", switch to Current Rates," : ""} or click All</div>
                  </div>
                )}
                <div className="px-4 py-3 text-[10px] text-white/15 text-left" style={{ fontFamily: "'JetBrains Mono', monospace", borderTop: "1px solid rgba(255,255,255,0.03)" }}>
                  Post-halving advisory: equipment under 0.450 MH/W is unprofitable below Level 5. Click any column header to sort. MH/$ = hashrate per hCASH spent (higher = better deal).
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
          <a href="https://hashcash.club?ref=0xf74D8ca88B666bd06f10614ca8ae1B8c9b43d206" target="_blank" rel="noreferrer" className="hover:text-white/40 transition-colors">hashcash.club</a>
          <a href="https://hashcash.club/docs" target="_blank" rel="noreferrer" className="hover:text-white/40 transition-colors">docs</a>
          <span>Not financial advice</span>
          <span>@willisdeving · Hashathon 2026</span>
        </div>
        <p className="text-white/10 text-[10px] mt-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          Like this build? Support your dev &mdash;{' '}
          <button
            onClick={() => { navigator.clipboard.writeText('0xf74D8ca88B666bd06f10614ca8ae1B8c9b43d206'); setToast('Address copied!'); setTimeout(() => setToast(null), 2500); }}
            className="text-white/20 hover:text-amber-400/50 transition-colors cursor-pointer"
            title="Click to copy address"
            style={{ background: "none", border: "none", fontFamily: "inherit", fontSize: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}
          >
            0xf74D8...3d206
          </button>
        </p>
      </footer>

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-2xl fade-slide"
          style={{ background: "#1a1f2e", border: "1px solid #fbbf2440", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
          <span className="text-emerald-400 mr-2">✓</span>
          <span className="text-white/80">{toast}</span>
        </div>
      )}
    </div>
  );
}
