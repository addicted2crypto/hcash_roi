import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const CHECKPOINT_PATH = path.resolve("data/scan-checkpoint.json");

export const dynamic = "force-dynamic";

// Wallet tag paths — mirrors lib/wallet-tags.js logic without the module import
const TAG_PATHS = [
  process.env.WALLET_TAGS_PATH,
  path.resolve("data/wallet-tags.json"),
  path.resolve("../AppIdeas/automation-bot/data/wallet-tags.json"),
  "C:/Users/William/OneDrive/Desktop/AppIdeas/automation-bot/data/wallet-tags.json",
].filter(Boolean);

function loadTags() {
  for (const p of TAG_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const arr = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!Array.isArray(arr)) continue;
      const map = {};
      for (const t of arr) {
        if (!t?.address || !t?.label) continue;
        map[t.address.toLowerCase()] = { label: String(t.label).slice(0, 32), tier: t.tier || null };
      }
      return map;
    } catch { /* try next */ }
  }
  return {};
}

export async function GET() {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    return NextResponse.json({ error: "Scan not started", wallets: [] }, { status: 503 });
  }

  let checkpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
  } catch (err) {
    return NextResponse.json({ error: "Failed to read checkpoint", message: String(err).slice(0, 200) }, { status: 500 });
  }

  const raw = checkpoint.wallets || {};
  const tagMap = loadTags();

  const wallets = Object.entries(raw).map(([addr, w]) => {
    const avaxIn  = Number(BigInt(w.avaxInWei  || "0")) / 1e18;
    const avaxOut = Number(BigInt(w.avaxOutWei || "0")) / 1e18;
    const netAvax = avaxOut - avaxIn;
    const status  = netAvax > 0.01 ? "profit" : netAvax < -0.01 ? "loss" : "even";
    const tag = tagMap[addr.toLowerCase()] || null;

    return {
      addr,
      avaxIn:  +avaxIn.toFixed(4),
      avaxOut: +avaxOut.toFixed(4),
      netAvax: +netAvax.toFixed(4),
      status,
      entries:          w.entries          || 0,
      minerBuys:        (w.minerAvaxBuys   || 0) + (w.minerHcashBuys  || 0),
      facilityUpgrades: w.facilityUpgrades || 0,
      marketBuys:       w.marketBuys       || 0,
      marketSells:      w.marketSells      || 0,
      dexSells:         w.dexSells         || 0,
      dexBuys:          w.dexBuys          || 0,
      label: tag?.label || null,
      tier:  tag?.tier  || null,
    };
  });

  // Default: sort by netAvax descending
  wallets.sort((a, b) => b.netAvax - a.netAvax);

  return NextResponse.json({
    wallets,
    total:        wallets.length,
    taggedCount:  wallets.filter(w => w.label).length,
    lastBlock:    checkpoint.lastProcessedBlock,
    savedAt:      checkpoint.meta?.lastSavedAt,
    scanRange:    checkpoint.scanRange,
  });
}
