import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { withFailover } from "@/lib/rpc-failover.js";
import { withSWR } from "@/lib/swr-cache.js";

const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const HC_API     = "https://api.hashcash.club/api/v1/public";
const HC_API_KEY = process.env.HC_API_KEY || "";

const CACHE_TTL = 2 * 60 * 1000;

// Block-time measurement cached separately (rarely changes, refresh hourly)
let blockTimeCache = { blocksPerDay: 85325, measuredAt: 0 };
const BLOCK_TIME_TTL = 60 * 60 * 1000;

export async function GET() {
  try {
    const { data, stale, ageMs } = await withSWR("game", CACHE_TTL, async () => {
      const abiRes = await fetch(HC_API + "/abis/main.v1.json", {
        headers: { "x-api-key": HC_API_KEY },
      }).then((r) => r.json());

      // ─── Top-level network reads ───
      const top = await withFailover(async (provider) => {
        const contract = new ethers.Contract(GAME_MAIN, abiRes.abi, provider);
        const [totalHashrate, blocksUntilHalving, bigcoinPerBlock, facilityCount, latestBlockNum] =
          await Promise.all([
            contract.totalHashrate(),
            contract.blocksUntilNextHalving(),
            contract.getBigcoinPerBlock(),
            contract.facilityCount(),
            provider.getBlockNumber(),
          ]);
        return { totalHashrate, blocksUntilHalving, bigcoinPerBlock, facilityCount, latestBlockNum };
      }, { label: "top", timeoutMs: 4000 });

      const netHash = Number(top.totalHashrate);
      const halvingBlocks = Number(top.blocksUntilHalving);
      const emission = Number(top.bigcoinPerBlock) / 1e18;
      const facCount = Number(top.facilityCount);
      const latestBlockNum = Number(top.latestBlockNum);

      // ─── Block time (hourly refresh, fallback to last good) ───
      const now = Date.now();
      let blocksPerDay = blockTimeCache.blocksPerDay;
      if (now - blockTimeCache.measuredAt > BLOCK_TIME_TTL) {
        try {
          const { bNow, bPast } = await withFailover(async (provider) => {
            const [a, b] = await Promise.all([
              provider.getBlock(latestBlockNum),
              provider.getBlock(latestBlockNum - 10000),
            ]);
            return { bNow: a, bPast: b };
          }, { label: "blockTime", timeoutMs: 4000 });
          if (bNow && bPast) {
            const avgBlockTime = (bNow.timestamp - bPast.timestamp) / 10000;
            if (avgBlockTime > 0.5 && avgBlockTime < 5) {
              blocksPerDay = Math.round(86400 / avgBlockTime);
              blockTimeCache = { blocksPerDay, measuredAt: now };
            }
          }
        } catch { /* keep previous cached value */ }
      }

      const halvingDays = Math.round(halvingBlocks / blocksPerDay);

      // ─── Facility configs (single failover round) ───
      // facilityCount() returns the HIGHEST VALID INDEX (e.g. 5 means Lv.1-5 exist).
      // Index 0 is an empty placeholder; loop must use <= to include the last facility.
      const facResults = await withFailover(async (provider) => {
        const contract = new ethers.Contract(GAME_MAIN, abiRes.abi, provider);
        const promises = [];
        for (let i = 0; i <= facCount; i++) promises.push(contract.facilities(i));
        return Promise.all(promises);
      }, { label: "facilities", timeoutMs: 5000 });

      const facilities = [];
      for (let i = 1; i < facResults.length; i++) {
        const f = facResults[i];
        const slots = Number(f.maxMiners);
        if (slots === 0) continue;

        const powerUnits = Number(f.totalPowerOutput);
        const powerW = powerUnits * 100;
        const elecCostPerBlock = Number(f.electricityCost) / 1e18;
        const cooldownSec = Number(f.cooldown);
        const gridX = Number(f.x);
        const gridY = Number(f.y);

        // Electricity: elecCostPerBlock * blocksPerDay = daily cost per power unit.
        // Convert to hCASH/kWh: (daily * 10) / 24 (since 1 kW = 10 power units).
        const dailyPerUnit = elecCostPerBlock * blocksPerDay;
        const elecRateKwh = (dailyPerUnit * 10) / 24;

        facilities.push({
          lvl: facilities.length + 1,
          slots,
          powerW,
          elecRate: +elecRateKwh.toFixed(2),
          elecCostPerBlock,
          cooldownD: Math.round(cooldownSec / 86400),
          gridX,
          gridY,
          grid: `${gridX}×${gridY}`,
        });
      }

      // Upgrade costs: idx 1 = Lv.1 (2 AVAX, 0 hCASH), idx 2 = Lv.2 (FREE), idx 3+ from contract
      const upgradeCosts = [0, 0];
      for (let i = 3; i < facResults.length; i++) {
        const cost = Number(facResults[i].cost) / 1e18;
        if (cost > 0 && cost < 1e50) upgradeCosts.push(cost);
      }

      let cumTotal = 0;
      facilities.forEach((f, i) => {
        if (i < upgradeCosts.length) cumTotal += upgradeCosts[i];
        f.totalHcash = cumTotal;
        f.costAvax = i === 0 ? 2 : 0;
      });

      // ─── Factory shop miners ───
      const uniqueMiners = await withFailover(async (provider) => {
        const c = new ethers.Contract(GAME_MAIN, abiRes.abi, provider);
        return Number(await c.uniqueMinerCount());
      }, { label: "uniqueMinerCount" });

      const reg = await fetch(HC_API + "/contracts", {
        headers: { "x-api-key": HC_API_KEY },
      }).then((r) => r.json());

      const minerRegistry = {};
      reg.contracts
        .filter((c) => c.category === "miner_nft")
        .forEach((m) => {
          const idx = parseInt(m.id.replace("miner_nft:", ""), 10);
          if (!isNaN(idx)) {
            minerRegistry[idx] = { name: m.name, img: m.imageUrl || "", stats: m.minerStats, nftAddr: m.address };
          }
        });

      const erc721Abi = ["function totalSupply() view returns (uint256)"];

      // Read miner configs in batches of 8 to avoid public RPC rate limits
      const minerResults = [];
      const BATCH_SIZE = 8;
      for (let start = 1; start <= uniqueMiners; start += BATCH_SIZE) {
        try {
          const batch = await withFailover(async (provider) => {
            const c = new ethers.Contract(GAME_MAIN, abiRes.abi, provider);
            const promises = [];
            for (let i = start; i < start + BATCH_SIZE && i <= uniqueMiners; i++) {
              promises.push(c.miners(i).then(m => ({ idx: i, m })).catch(() => null));
            }
            return Promise.all(promises);
          }, { label: `miners[${start}]`, timeoutMs: 4000 });
          batch.forEach(r => r && minerResults.push(r));
        } catch {
          // skip failed batch — continue rather than blanking the whole shop
        }
      }

      const candidateMiners = [];
      for (const { idx, m } of minerResults) {
        const hash = Number(m.hashrate);
        const powerUnits = Number(m.powerConsumption);
        const powerW = powerUnits * 100;
        const costRaw = Number(m.cost) / 1e18;
        const avaxCostRaw = Number(m.avaxCost) / 1e18;
        const inProd = m.inProduction;
        const maxSupply = Number(m.maxSupply);
        if (hash <= 0 || !inProd || costRaw >= 90000) continue;
        candidateMiners.push({ idx, hash, powerW, costRaw, avaxCostRaw, inProd, maxSupply });
      }

      // totalSupply per NFT contract — batched + failover
      const supplyMap = {};
      for (let start = 0; start < candidateMiners.length; start += BATCH_SIZE) {
        const slice = candidateMiners.slice(start, start + BATCH_SIZE);
        try {
          const results = await withFailover(async (provider) => {
            return Promise.all(slice.map(async (cm) => {
              const reg = minerRegistry[cm.idx];
              if (!reg?.nftAddr) return null;
              try {
                const nft = new ethers.Contract(reg.nftAddr, erc721Abi, provider);
                const minted = Number(await nft.totalSupply());
                return { idx: cm.idx, minted };
              } catch { return null; }
            }));
          }, { label: `supply[${start}]`, timeoutMs: 4000 });
          results.forEach(r => { if (r) supplyMap[r.idx] = r.minted; });
        } catch {
          // skip — minted defaults to 0, remaining will read as full supply
        }
      }

      const shopMiners = candidateMiners.map(cm => {
        const regEntry = minerRegistry[cm.idx];
        const minted = supplyMap[cm.idx] ?? 0;
        const remaining = Math.max(0, cm.maxSupply - minted);
        return {
          minerIndex: cm.idx,
          id: `miner${cm.idx}`,
          name: regEntry?.name || `Miner #${cm.idx}`,
          hash: cm.hash,
          powerW: cm.powerW,
          costHcash: Math.round(cm.costRaw),
          avaxCost: cm.avaxCostRaw > 0 ? +cm.avaxCostRaw.toFixed(4) : 0,
          inProduction: cm.inProd,
          maxSupply: cm.maxSupply,
          minted,
          remaining,
          soldOut: remaining === 0,
          img: regEntry?.img || "",
          source: "factory",
        };
      });

      return {
        network: {
          totalHashrate: netHash,
          emission,
          halvingBlocks,
          halvingDays,
          postHalvingEmission: emission / 2,
          blocksPerDay,
        },
        facilities,
        shopMiners,
        updatedAt: new Date().toISOString(),
      };
    });

    return NextResponse.json({ ...data, stale, ageMs });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch game data", facilities: [], network: null },
      { status: 500 }
    );
  }
}
