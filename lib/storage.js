// Unified JSON storage abstraction.
//
// In production (Vercel), the local filesystem is read-only outside /tmp,
// so any data we write from cron routes must go to Vercel Blob to persist
// between invocations. Locally + in CLI scripts, we use the filesystem so
// dev iteration stays fast and the existing scan scripts keep working.
//
// Mode selection:
//   BLOB_READ_WRITE_TOKEN set     → Blob mode
//   FORCE_LOCAL_STORAGE=1         → fs mode (escape hatch for local-only ops)
//   otherwise                     → fs mode (dev / CLI)
//
// Free-tier protection:
//   Vercel Blob free tier = 100K simple ops/month. We layer in-memory cache
//   (60s TTL) on every read so a route polled every 60s with 50 visitors
//   doesn't burn through the quota — at most one head() per minute per file.

import fs from "node:fs";
import path from "node:path";

const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN && process.env.FORCE_LOCAL_STORAGE !== "1";

// In-memory cache: name → { data, fetchedAt }
const cache = new Map();
const READ_TTL_MS = 60 * 1000;

// Lazy import @vercel/blob only when actually needed
let blobMod = null;
async function getBlob() {
  if (!blobMod) {
    blobMod = await import("@vercel/blob");
  }
  return blobMod;
}

// All keys map to deterministic Blob pathnames. Mirrors the file layout we
// had on disk so existing helpers translate cleanly.
const KEYS = {
  WATCHER_STATE:   "data/watcher-state.json",
  LEADERBOARD_DELTA: "data/leaderboard-delta.json",
  COST_CHANGES:    "data/cost-changes.json",
  LAUNCHING:       "data/launching-now.json",
  REGISTRY_SNAPSHOT: "data/registry-snapshot.json",
  NEW_DROPS:       "data/new-drops.json",
  INTEGRITY_ISSUES: "data/integrity-issues.json",
  COHORTS:         "data/profitability-cohorts.json",
  WALLET_PNL:      "data/wallet-pnl.json",
  SCAN_CHECKPOINT: "data/scan-checkpoint.json",
};

export { KEYS };

// ─── Cache layer ────────────────────────────────────────────────────────────
function cacheGet(name) {
  const e = cache.get(name);
  if (!e) return null;
  if (Date.now() - e.fetchedAt > READ_TTL_MS) {
    cache.delete(name);
    return null;
  }
  return e.data;
}

function cacheSet(name, data) {
  cache.set(name, { data, fetchedAt: Date.now() });
}

function cacheBust(name) { cache.delete(name); }

// ─── Local filesystem mode ──────────────────────────────────────────────────
function fsRead(name) {
  const p = path.resolve(name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function fsWrite(name, data) {
  const p = path.resolve(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function fsStat(name) {
  const p = path.resolve(name);
  if (!fs.existsSync(p)) return null;
  try { return fs.statSync(p); } catch { return null; }
}

// ─── Blob mode ──────────────────────────────────────────────────────────────
// Cache the discovered URL per key after first head() — saves an op per read.
const blobUrlCache = new Map();

async function blobHead(name) {
  const cached = blobUrlCache.get(name);
  if (cached) return cached;
  try {
    const { head } = await getBlob();
    const meta = await head(name, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (meta?.url) blobUrlCache.set(name, meta);
    return meta;
  } catch {
    return null; // 404 / not yet written
  }
}

async function blobRead(name) {
  const meta = await blobHead(name);
  if (!meta?.url) return null;
  try {
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function blobWrite(name, data) {
  const { put } = await getBlob();
  const result = await put(name, JSON.stringify(data, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  // Refresh the URL cache with the URL we just got back
  if (result?.url) blobUrlCache.set(name, { url: result.url, uploadedAt: new Date() });
  return result;
}

async function blobStat(name) {
  const meta = await blobHead(name);
  if (!meta) return null;
  return {
    mtimeMs: meta.uploadedAt ? new Date(meta.uploadedAt).getTime() : Date.now(),
    size: meta.size || 0,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────
export async function getJson(name, fallback = null) {
  const cached = cacheGet(name);
  if (cached !== null) return cached;
  let data;
  if (USE_BLOB) data = await blobRead(name);
  else data = fsRead(name);
  if (data === null || data === undefined) return fallback;
  cacheSet(name, data);
  return data;
}

export async function putJson(name, data) {
  cacheSet(name, data); // optimistically update cache so the writer sees its own write
  if (USE_BLOB) await blobWrite(name, data);
  else fsWrite(name, data);
  return data;
}

export async function statJson(name) {
  if (USE_BLOB) return await blobStat(name);
  const s = fsStat(name);
  return s ? { mtimeMs: s.mtimeMs, size: s.size } : null;
}

export function invalidate(name) { cacheBust(name); }

export function isBlobMode() { return USE_BLOB; }
