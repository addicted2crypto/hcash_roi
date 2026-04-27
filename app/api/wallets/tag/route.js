import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// TAG_AUTH_KEY must be set in .env to enable writes. Unset = 401 for all mutations.
// Set it in Vercel env vars or .env.local — never commit the value.
function checkAuth(req) {
  const key = process.env.TAG_AUTH_KEY;
  if (!key) return false; // no key configured = writes disabled
  const header = req.headers.get("x-tag-auth") || "";
  return header === key;
}

const TAG_PATHS = [
  process.env.WALLET_TAGS_PATH,
  path.resolve("data/wallet-tags.json"),
].filter(Boolean);

function findWritablePath() {
  for (const p of TAG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return path.resolve("data/wallet-tags.json");
}

export async function POST(req) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { address, label, tier = "unknown" } = body;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  const cleanLabel = String(label || "").trim().slice(0, 32);
  if (!cleanLabel) {
    return NextResponse.json({ error: "Label is required" }, { status: 400 });
  }

  const filePath = findWritablePath();
  let tags = [];
  try {
    if (fs.existsSync(filePath)) {
      tags = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!Array.isArray(tags)) tags = [];
    }
  } catch { tags = []; }

  const normalAddr = address.toLowerCase();
  const existing = tags.findIndex(t => t.address?.toLowerCase() === normalAddr);
  const now = new Date().toISOString();

  if (existing >= 0) {
    tags[existing] = { ...tags[existing], label: cleanLabel, tier, updatedAt: now };
  } else {
    tags.push({ address: normalAddr, label: cleanLabel, tier, addedAt: now, updatedAt: now });
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tags, null, 2));
  } catch (err) {
    return NextResponse.json({ error: "Failed to write tags", message: String(err).slice(0, 200) }, { status: 500 });
  }

  // Never return filePath — don't expose server disk layout
  return NextResponse.json({ ok: true, address: normalAddr, label: cleanLabel, tier });
}

export async function DELETE(req) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { address } = body;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const filePath = findWritablePath();
  if (!fs.existsSync(filePath)) return NextResponse.json({ ok: true, removed: 0 });

  let tags = [];
  try { tags = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return NextResponse.json({ error: "Failed to read tags" }, { status: 500 }); }

  const normalAddr = address.toLowerCase();
  const filtered = tags.filter(t => t.address?.toLowerCase() !== normalAddr);
  fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));

  return NextResponse.json({ ok: true, removed: tags.length - filtered.length });
}
