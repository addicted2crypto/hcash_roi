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
    // AVAX-priced listings use native currency (zero address in thirdweb marketplace)
    const NATIVE_AVAX = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    for (let s = 0; s < total; s += batchSize) {
      const e = Math.min(s + batchSize, total);
      try {
        const listings = await contract.getAllValidListings(s, e);
        for (const l of listings) {
          const nftAddr = l.assetContract.toLowerCase();
          const miner = minerMap[nftAddr];
          if (!miner || !miner.stats) continue;

          const currency = l.currency.toLowerCase();
          const price = Number(BigInt(l.pricePerToken)) / 1e18;
          const key = miner.name;

          // Initialize entry if missing
          if (!floors[key]) {
            floors[key] = {
              id: miner.id,
              name: miner.name,
              hash: miner.stats.hashrateMhps || 0,
              powerW: miner.stats.powerWatts || 0,
              costHcash: null,
              costAvax: null,
              hcashListings: 0,
              avaxListings: 0,
              avail: true,
              img: miner.img,
            };
          }

          if (currency === HCASH_TOKEN) {
            const p = Math.round(price);
            if (floors[key].costHcash === null || p < floors[key].costHcash) {
              floors[key].costHcash = p;
            }
            floors[key].hcashListings += 1;
          } else if (currency === NATIVE_AVAX || currency === "0x0000000000000000000000000000000000000000") {
            if (floors[key].costAvax === null || price < floors[key].costAvax) {
              floors[key].costAvax = +price.toFixed(3);
            }
            floors[key].avaxListings += 1;
          }
        }
      } catch {
        // skip failed batch
      }
    }

    // Set primary costHcash + listings counter (for backwards compat with existing UI)
    Object.values(floors).forEach(m => {
      m.listings = (m.hcashListings || 0) + (m.avaxListings || 0);
      // If a miner has no hCASH listing but has AVAX, still show it
      if (m.costHcash === null && m.costAvax === null) m.avail = false;
    });

    const miners = Object.values(floors)
      .filter((m) => m.hash > 0 && (m.costHcash !== null || m.costAvax !== null))
      .sort((a, b) => (a.costHcash ?? Infinity) - (b.costHcash ?? Infinity));

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
