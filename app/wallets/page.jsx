"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

function trunc(addr, h = 6, t = 4) {
  if (!addr || addr.length < h + t + 2) return addr;
  return `${addr.slice(0, h)}…${addr.slice(-t)}`;
}

const FILTERS = [
  { key: "all",    label: "ALL" },
  { key: "profit", label: "PROFIT" },
  { key: "loss",   label: "LOSS" },
  { key: "even",   label: "BREAKEVEN" },
  { key: "player", label: "PLAYERS ONLY" },
  { key: "market", label: "MARKET ACTIVE" },
];

const SORT_COLS = [
  { key: "netAvax",   label: "NET AVAX" },
  { key: "avaxIn",    label: "AVAX IN" },
  { key: "avaxOut",   label: "AVAX OUT" },
  { key: "entries",   label: "ENTRIES" },
  { key: "marketSells", label: "MKT SELLS" },
  { key: "minerBuys", label: "MINER BUYS" },
];

export default function WalletsPage() {
  const [wallets,    setWallets]    = useState(null);
  const [meta,       setMeta]       = useState(null);
  const [error,      setError]      = useState(null);
  const [filter,     setFilter]     = useState("all");
  const [sortKey,    setSortKey]    = useState("netAvax");
  const [sortDir,    setSortDir]    = useState("desc");
  const [namesOn,    setNamesOn]    = useState(false);
  const [page,       setPage]       = useState(0);
  const [tagging,    setTagging]    = useState(null); // addr being tagged
  const [tagInput,   setTagInput]   = useState("");
  const [tagSaving,  setTagSaving]  = useState(false);
  const PAGE_SIZE = 50;

  async function saveTag(addr) {
    if (!tagInput.trim()) return;
    // Auth key stored in sessionStorage — never in JS bundle or URL
    let authKey = typeof window !== "undefined" ? sessionStorage.getItem("tag_auth") : "";
    if (!authKey) {
      authKey = window.prompt("Enter tag auth key:");
      if (!authKey) return;
      sessionStorage.setItem("tag_auth", authKey);
    }
    setTagSaving(true);
    try {
      const res = await fetch("/api/wallets/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tag-auth": authKey },
        body: JSON.stringify({ address: addr, label: tagInput.trim() }),
      });
      if (res.status === 401) {
        sessionStorage.removeItem("tag_auth");
        window.alert("Auth key incorrect.");
        return;
      }
      if (res.ok) {
        const label = tagInput.trim();
        setWallets(ws => ws.map(w => w.addr === addr ? { ...w, label } : w));
        setMeta(m => ({ ...m, taggedCount: m.taggedCount + (wallets.find(w => w.addr === addr)?.label ? 0 : 1) }));
        setNamesOn(true);
      }
    } finally {
      setTagSaving(false);
      setTagging(null);
      setTagInput("");
    }
  }

  function startTag(addr, currentLabel) {
    setTagging(addr);
    setTagInput(currentLabel || "");
  }

  useEffect(() => {
    fetch("/api/wallets")
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return; }
        setWallets(d.wallets);
        setMeta({ total: d.total, taggedCount: d.taggedCount, lastBlock: d.lastBlock, savedAt: d.savedAt });
      })
      .catch(e => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!wallets) return [];
    let rows = wallets;
    if (filter === "profit")  rows = rows.filter(w => w.status === "profit");
    if (filter === "loss")    rows = rows.filter(w => w.status === "loss");
    if (filter === "even")    rows = rows.filter(w => w.status === "even");
    if (filter === "player")  rows = rows.filter(w => w.entries > 0);
    if (filter === "market")  rows = rows.filter(w => w.marketBuys + w.marketSells > 0);
    return [...rows].sort((a, b) => {
      const v = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
      return sortDir === "asc" ? v : -v;
    });
  }, [wallets, filter, sortKey, sortDir]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows   = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortIcon({ col }) {
    if (sortKey !== col) return <span className="text-white/20 ml-1">↕</span>;
    return <span className="text-amber-400 ml-1">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  const statusDot = { profit: "text-emerald-400", loss: "text-red-400/80", even: "text-white/30" };
  const statusLabel = { profit: "profit", loss: "loss", even: "—" };

  if (error) return (
    <div className="min-h-screen flex items-center justify-center text-red-400/80" style={MONO}>
      Error: {error}
    </div>
  );

  if (!wallets) return (
    <div className="min-h-screen flex items-center justify-center" style={MONO}>
      <div className="text-center">
        <div className="text-[10px] tracking-[0.3em] text-amber-400/60 mb-3">LOADING WALLET INDEX</div>
        <div className="text-white/30 text-sm">Reading checkpoint…</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen pt-12 pb-24 px-4 bg-[#06080e] text-white">
      <div className="max-w-6xl mx-auto">

        {/* ─── HEADER ─── */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[10px] tracking-[0.3em] text-emerald-400/50 mb-2" style={MONO}>
              ON-CHAIN WALLET INDEX · {meta.total.toLocaleString()} ADDRESSES
            </div>
            <h1 className="text-3xl font-bold tracking-tight">
              Every wallet that touched hCASH.
            </h1>
            <p className="text-white/40 text-sm mt-1">
              Sorted by net AVAX P&L. Data from scan checkpoint{" "}
              {meta.lastBlock && <span>· block {meta.lastBlock.toLocaleString()}</span>}.
            </p>
          </div>

          {/* Unlock names toggle */}
          <button
            onClick={() => setNamesOn(v => !v)}
            className={`shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg border text-xs tracking-widest transition-all ${
              namesOn
                ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
                : "border-white/10 bg-white/4 text-white/40 hover:text-white/70 hover:border-white/20"
            }`}
            style={MONO}
          >
            <span>{namesOn ? "🔓" : "🔒"}</span>
            <span>{namesOn ? "NAMES ON" : "UNLOCK NAMES"}</span>
            {meta.taggedCount > 0 && (
              <span className={`text-[10px] ${namesOn ? "text-amber-400/60" : "text-white/20"}`}>
                ({meta.taggedCount})
              </span>
            )}
          </button>
        </header>

        {/* ─── FILTER TABS ─── */}
        <div className="flex flex-wrap gap-2 mb-6">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setPage(0); }}
              className={`px-3 py-1.5 rounded-md text-[10px] tracking-widest transition-all border ${
                filter === f.key
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-400"
                  : "border-white/8 text-white/40 hover:text-white/60 hover:border-white/15"
              }`}
              style={MONO}
            >
              {f.label}
              {f.key !== "all" && <span className="ml-1.5 text-white/20">
                {f.key === "profit" ? wallets.filter(w => w.status === "profit").length
                : f.key === "loss"   ? wallets.filter(w => w.status === "loss").length
                : f.key === "even"   ? wallets.filter(w => w.status === "even").length
                : f.key === "player" ? wallets.filter(w => w.entries > 0).length
                : wallets.filter(w => w.marketBuys + w.marketSells > 0).length}
              </span>}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-white/20 self-center" style={MONO}>
            {filtered.length.toLocaleString()} wallets
          </span>
        </div>

        {/* ─── TABLE ─── */}
        <div className="overflow-x-auto rounded-xl border border-white/5">
          <table className="w-full text-xs" style={MONO}>
            <thead className="bg-white/2 border-b border-white/5">
              <tr className="text-left text-[10px] tracking-wider text-white/40 uppercase">
                <th className="py-3 px-3 w-10">#</th>
                <th className="py-3 px-3">Wallet</th>
                {SORT_COLS.map(col => (
                  <th
                    key={col.key}
                    className="py-3 px-3 cursor-pointer hover:text-white/70 transition-colors whitespace-nowrap select-none"
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label}<SortIcon col={col.key} />
                  </th>
                ))}
                <th className="py-3 px-3">STATUS</th>
                <th className="py-3 px-3 sr-only">Link</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((w, i) => {
                const rank = page * PAGE_SIZE + i + 1;
                const showLabel = namesOn && w.label;
                return (
                  <tr key={w.addr} className="border-t border-white/4 hover:bg-white/2 transition-colors group">
                    <td className="py-2.5 px-3 text-white/20 tabular-nums">{rank}</td>
                    <td className="py-2.5 px-3">
                      {tagging === w.addr ? (
                        <form
                          onSubmit={e => { e.preventDefault(); saveTag(w.addr); }}
                          className="flex items-center gap-1.5"
                          onClick={e => e.stopPropagation()}
                        >
                          <input
                            autoFocus
                            value={tagInput}
                            onChange={e => setTagInput(e.target.value)}
                            placeholder="enter name…"
                            maxLength={32}
                            className="bg-white/8 border border-amber-400/30 rounded px-2 py-0.5 text-xs text-white placeholder-white/20 outline-none focus:border-amber-400/60 w-32"
                            style={MONO}
                          />
                          <button type="submit" disabled={tagSaving || !tagInput.trim()}
                            className="text-[10px] text-amber-400 hover:text-amber-300 disabled:opacity-40" style={MONO}>
                            {tagSaving ? "…" : "SAVE"}
                          </button>
                          <button type="button" onClick={() => { setTagging(null); setTagInput(""); }}
                            className="text-[10px] text-white/30 hover:text-white/60" style={MONO}>
                            ✕
                          </button>
                        </form>
                      ) : (
                        <div className="flex items-center gap-2 min-w-0">
                          <Link
                            href={`/wallet/${w.addr}`}
                            className="text-cyan-400/80 hover:text-cyan-400 transition-colors shrink-0"
                            title={w.addr}
                          >
                            {trunc(w.addr, 7, 5)}
                          </Link>
                          {showLabel && (
                            <span className="text-amber-400/80 text-[10px] border border-amber-400/20 px-1.5 py-0.5 rounded shrink-0 cursor-pointer hover:border-amber-400/50"
                              onClick={() => startTag(w.addr, w.label)} title="Edit name">
                              {w.label}
                            </span>
                          )}
                          <button
                            onClick={() => startTag(w.addr, w.label)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-white/20 hover:text-amber-400/70 text-[10px] shrink-0"
                            title="Tag this wallet"
                            style={MONO}
                          >
                            {w.label ? "✎" : "+name"}
                          </button>
                        </div>
                      )}
                    </td>
                    <td className={`py-2.5 px-3 tabular-nums ${w.avaxIn > 0 ? "text-white/60" : "text-white/20"}`}>
                      {w.avaxIn > 0 ? w.avaxIn.toFixed(2) : "—"}
                    </td>
                    <td className={`py-2.5 px-3 tabular-nums ${w.avaxOut > 0 ? "text-white/60" : "text-white/20"}`}>
                      {w.avaxOut > 0 ? w.avaxOut.toFixed(2) : "—"}
                    </td>
                    <td className={`py-2.5 px-3 tabular-nums font-semibold ${
                      w.netAvax > 0.01 ? "text-emerald-400" : w.netAvax < -0.01 ? "text-red-400/80" : "text-white/30"
                    }`}>
                      {w.netAvax > 0.01 ? "+" : ""}{w.netAvax !== 0 ? w.netAvax.toFixed(2) : "0.00"}
                    </td>
                    <td className="py-2.5 px-3 tabular-nums text-white/50">{w.entries || "—"}</td>
                    <td className="py-2.5 px-3 tabular-nums text-white/50">{w.marketSells || "—"}</td>
                    <td className="py-2.5 px-3 tabular-nums text-white/50">{w.minerBuys || "—"}</td>
                    <td className={`py-2.5 px-3 text-[10px] tracking-wider ${statusDot[w.status] || "text-white/30"}`}>
                      {statusLabel[w.status]}
                    </td>
                    <td className="py-2.5 px-2">
                      <Link
                        href={`/wallet/${w.addr}`}
                        className="text-[10px] text-white/20 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        ↗
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ─── PAGINATION ─── */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 px-1">
            <button
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
              className="px-4 py-2 rounded-lg border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-xs transition-all"
              style={MONO}
            >
              ← PREV
            </button>
            <span className="text-[10px] text-white/30 tabular-nums" style={MONO}>
              {page + 1} / {totalPages} · {filtered.length.toLocaleString()} wallets
            </span>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => p + 1)}
              className="px-4 py-2 rounded-lg border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-xs transition-all"
              style={MONO}
            >
              NEXT →
            </button>
          </div>
        )}

        {/* ─── FOOTER NOTE ─── */}
        <div className="mt-8 text-[10px] text-white/20 border-t border-white/5 pt-4" style={MONO}>
          <span>
            Checkpoint block {meta.lastBlock?.toLocaleString()} · {meta.savedAt ? new Date(meta.savedAt).toUTCString() : "—"} ·{" "}
            AVAX flows from marketplace + DEX events only. Current hCASH balance not included here — see{" "}
            <Link href="/profitability" className="text-cyan-400/50 hover:text-cyan-400">/profitability</Link>{" "}
            for full P&L.
          </span>
        </div>

      </div>
    </div>
  );
}
