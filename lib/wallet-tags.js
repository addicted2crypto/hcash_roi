// Wallet → label map sourced from external tag store.
// The user's automation-bot maintains a community-curated tag file at:
//   C:/Users/William/OneDrive/Desktop/AppIdeas/automation-bot/data/wallet-tags.json
// In production we point this at a synced file inside the repo or a env-configured path.
//
// Format expected:
//   [{ "address": "0x...", "label": "averageandy", "tier": "unknown", ... }, ...]
//
// Read with a 60s in-process cache so high-traffic routes don't re-stat the file
// on every request, but new tags appear within a minute.

import fs from "node:fs";
import path from "node:path";

const TAG_PATHS = [
  process.env.WALLET_TAGS_PATH,
  path.resolve("data/wallet-tags.json"),
  path.resolve("../AppIdeas/automation-bot/data/wallet-tags.json"),
  "C:/Users/William/OneDrive/Desktop/AppIdeas/automation-bot/data/wallet-tags.json",
].filter(Boolean);

let cache = null;
let cacheAt = 0;
const TTL_MS = 60 * 1000;

function loadTagsFresh() {
  for (const p of TAG_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      const map = {};
      for (const t of arr) {
        if (!t?.address || !t?.label) continue;
        map[t.address.toLowerCase()] = {
          label: String(t.label).slice(0, 32), // safety cap
          tier: t.tier || null,
        };
      }
      return { map, source: p, count: Object.keys(map).length };
    } catch { /* try next path */ }
  }
  return { map: {}, source: null, count: 0 };
}

export function getWalletTags() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  cache = loadTagsFresh();
  cacheAt = now;
  return cache;
}

export function tagFor(addr) {
  if (!addr) return null;
  const { map } = getWalletTags();
  return map[addr.toLowerCase()] || null;
}

// Render-helper: returns "0xABCD…1234 (label)" or just truncated addr if no tag
export function labeledAddr(addr, truncFn) {
  const trunc = truncFn ? truncFn(addr) : addr;
  const tag = tagFor(addr);
  return tag ? `${trunc} (${tag.label})` : trunc;
}
