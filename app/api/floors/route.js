import { ethers } from "ethers";
import { NextResponse } from "next/server";

const AVAX_RPC    = "https://api.avax.network/ext/bc/C/rpc";
const MARKETPLACE = "0x511FC8b8e5D07a012D17f56fE8bfdE576c8Dd13d";
const HC_API      = "https://api.hashcash.club/api/v1/public";
const HC_API_KEY  = process.env.HC_API_KEY || "";
const HCASH_TOKEN = "0xba5444409257967e5e50b113c395a766b0678c03";

// Cache: refresh every 5 minutes
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function GET() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  try {
    const provider = new ethers.JsonRpcProvider(AVAX_RPC);

    // 1. Get marketplace ABI
    const abiRes = await fetch(HC_API + "/abis/marketplace.v1.json", {
      headers: { "x-api-key": HC_API_KEY },
    }).then((r) => r.json());

    const contract = new ethers.Contract(MARKETPLACE, abiRes.abi, provider);

    // 2. Get miner registry (names, stats, images)
    const reg = await fetch(HC_API + "/contracts", {
      headers: { "x-api-key": HC_API_KEY },
    }).then((r) => r.json());

    const minerMap = {};
    reg.contracts
      .filter((c) => c.category === "miner_nft")
      .forEach((m) => {
        minerMap[m.address.toLowerCase()] = {
          name: m.name,
          id: m.id,
          stats: m.minerStats,
          img: m.imageUrl || "",
        };
      });

    // 3. Scan all listings in batches
    const total = Number(await contract.totalListings());
    const floors = {};
    const batchSize = 200;

    for (let s = 0; s < total; s += batchSize) {
      const e = Math.min(s + batchSize, total);
      try {
        const listings = await contract.getAllValidListings(s, e);
        for (const l of listings) {
          const nftAddr = l.assetContract.toLowerCase();
          const miner = minerMap[nftAddr];
          if (!miner || !miner.stats) continue;

          const currency = l.currency.toLowerCase();
          if (currency !== HCASH_TOKEN) continue;

          const priceHcash = Math.round(Number(BigInt(l.pricePerToken)) / 1e18);
          const key = miner.name;

          if (!floors[key] || priceHcash < floors[key].costHcash) {
            floors[key] = {
              id: miner.id,
              name: miner.name,
              hash: miner.stats.hashrateMhps || 0,
              powerW: miner.stats.powerWatts || 0,
              costHcash: priceHcash,
              avail: true,
              img: miner.img,
              listings: 1,
            };
          } else {
            floors[key].listings = (floors[key].listings || 0) + 1;
          }
        }
      } catch {
        // skip failed batch
      }
    }

    const miners = Object.values(floors)
      .filter((m) => m.hash > 0)
      .sort((a, b) => a.costHcash - b.costHcash);

    const result = {
      miners,
      totalListings: total,
      validMiners: miners.length,
      updatedAt: new Date().toISOString(),
    };

    cache = result;
    cacheTime = now;

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch marketplace data", miners: [] },
      { status: 500 }
    );
  }
}
