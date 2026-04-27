import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { isValidAddress } from "@/lib/snowtrace";

const WALLETS_PATH = path.resolve("data/wallet-pnl.json");

export async function GET(_req, { params }) {
  const { address } = await params;
  const lower = (address || "").toLowerCase();

  if (!isValidAddress(lower)) {
    return NextResponse.json(
      { error: "Invalid address — must match 0x[40 hex]" },
      { status: 400 }
    );
  }

  if (!fs.existsSync(WALLETS_PATH)) {
    return NextResponse.json(
      { error: "Wallet index has not been built yet — scan still running", wallet: null },
      { status: 503 }
    );
  }

  try {
    const stat = fs.statSync(WALLETS_PATH);
    const data = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
    const wallet = data[lower] || null;
    const ageMs = Date.now() - stat.mtimeMs;
    const stale = ageMs > 24 * 60 * 60 * 1000;

    if (!wallet) {
      // 200 with empty body — wallet is shape-valid but never touched the game.
      // Returning 404 would block SEO indexing of valid hex addresses (per UX plan).
      return NextResponse.json({
        address: lower,
        found: false,
        ageMs,
        stale,
        fileUpdatedAt: new Date(stat.mtimeMs).toISOString(),
      });
    }

    return NextResponse.json({
      address: lower,
      found: true,
      ...wallet,
      ageMs,
      stale,
      fileUpdatedAt: new Date(stat.mtimeMs).toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to read wallet data", message: String(err).slice(0, 200) },
      { status: 500 }
    );
  }
}
