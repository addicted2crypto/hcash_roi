import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { withFailover } from "@/lib/rpc-failover.js";
import { withSWR } from "@/lib/swr-cache.js";

const MARKETPLACE = "0x511FC8b8e5D07a012D17f56fE8bfdE576c8Dd13d";
const HC_API      = "https://api.hashcash.club/api/v1/public";
const HC_API_KEY  = process.env.HC_API_KEY || "";
const HCASH_TOKEN = "0xba5444409257967e5e50b113c395a766b0678c03";

const CACHE_TTL = 5 * 60 * 1000;

export async function GET() {
  try {
    const { data, stale, ageMs } = await withSWR("floors", CACHE_TTL, async () => {
      // 1. Get marketplace ABI + miner registry (these don't need failover — they're HTTP)
      const [abiRes, reg] = await Promise.all([
        fetch(HC_API + "/abis/marketplace.v1.json", {
          headers: { "x-api-key": HC_API_KEY },
        }).then((r) => r.json()),
        fetch(HC_API + "/contracts", {
          headers: { "x-api-key": HC_API_KEY },
        }).then((r) => r.json()),
      ]);

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

      // 2. totalListings via failover
      const total = await withFailover(async (provider) => {
        const c = new ethers.Contract(MARKETPLACE, abiRes.abi, provider);
        return Number(await c.totalListings());
      }, { label: "totalListings" });

      const floors = {};
      const batchSize = 200;
      const NATIVE_AVAX = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

      for (let s = 0; s < total; s += batchSize) {
        const e = Math.min(s + batchSize, total);
        try {
          const listings = await withFailover(async (provider) => {
            const c = new ethers.Contract(MARKETPLACE, abiRes.abi, provider);
            return c.getAllValidListings(s, e);
          }, { label: `listings[${s}-${e}]`, timeoutMs: 4000 });

          for (const l of listings) {
            const nftAddr = l.assetContract.toLowerCase();
            const miner = minerMap[nftAddr];
            if (!miner || !miner.stats) continue;

            const currency = l.currency.toLowerCase();
            const price = Number(BigInt(l.pricePerToken)) / 1e18;
            const key = miner.name;

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
          // one bad batch shouldn't sink the whole response — skip and continue
        }
      }

      Object.values(floors).forEach(m => {
        m.listings = (m.hcashListings || 0) + (m.avaxListings || 0);
        if (m.costHcash === null && m.costAvax === null) m.avail = false;
      });

      const miners = Object.values(floors)
        .filter((m) => m.hash > 0 && (m.costHcash !== null || m.costAvax !== null))
        .sort((a, b) => (a.costHcash ?? Infinity) - (b.costHcash ?? Infinity));

      return {
        miners,
        totalListings: total,
        validMiners: miners.length,
        updatedAt: new Date().toISOString(),
      };
    });

    return NextResponse.json({ ...data, stale, ageMs });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch marketplace data", miners: [] },
      { status: 500 }
    );
  }
}
