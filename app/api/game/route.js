import { ethers } from "ethers";
import { NextResponse } from "next/server";

const AVAX_RPC   = "https://api.avax.network/ext/bc/C/rpc";
const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const HC_API     = "https://api.hashcash.club/api/v1/public";
const HC_API_KEY = process.env.HC_API_KEY || "";

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000;

// Block-time measurement cached separately (rarely changes, refresh hourly)
let blockTimeCache = { blocksPerDay: 85325, measuredAt: 0 };
const BLOCK_TIME_TTL = 60 * 60 * 1000; // 1 hour

export async function GET() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  try {
    const provider = new ethers.JsonRpcProvider(AVAX_RPC);
    const abiRes = await fetch(HC_API + "/abis/main.v1.json", {
      headers: { "x-api-key": HC_API_KEY },
    }).then((r) => r.json());

    const contract = new ethers.Contract(GAME_MAIN, abiRes.abi, provider);

    const [totalHashrate, blocksUntilHalving, bigcoinPerBlock, facilityCount, latestBlockNum] =
      await Promise.all([
        contract.totalHashrate(),
        contract.blocksUntilNextHalving(),
        contract.getBigcoinPerBlock(),
        contract.facilityCount(),
        provider.getBlockNumber(),
      ]);

    const netHash = Number(totalHashrate);
    const halvingBlocks = Number(blocksUntilHalving);
    const emission = Number(bigcoinPerBlock) / 1e18;
    const facCount = Number(facilityCount);

    // Block time rarely shifts meaningfully — measure hourly, not every request
    let blocksPerDay = blockTimeCache.blocksPerDay;
    if (now - blockTimeCache.measuredAt > BLOCK_TIME_TTL) {
      try {
        const [bNow, bPast] = await Promise.all([
          provider.getBlock(latestBlockNum),
          provider.getBlock(latestBlockNum - 10000),
        ]);
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

    // Read all facility configs.
    // facilityCount() returns the HIGHEST VALID INDEX (e.g. 5 means Lv.1-5 exist),
    // not the count. Index 0 is an empty placeholder. Loop must use <= to include the last facility.
    const facPromises = [];
    for (let i = 0; i <= facCount; i++) {
      facPromises.push(contract.facilities(i));
    }
    const facResults = await Promise.all(facPromises);

    // Contract uses 0-indexed, index 0 is empty placeholder
    // Real facilities start at index 1
    const facilities = [];
    let cumUpgradeCost = 0;

    for (let i = 1; i < facResults.length; i++) {
      const f = facResults[i];
      const slots = Number(f.maxMiners);
      if (slots === 0) continue; // skip empty entries

      const powerUnits = Number(f.totalPowerOutput);
      const powerW = powerUnits * 100; // contract units → watts
      const elecRaw = Number(f.cost) / 1e18;
      const upgradeCost = i <= 2 ? 0 : Number(f.cost) / 1e18; // index 1-2 special handling
      const elecCostPerBlock = Number(f.electricityCost) / 1e18;
      const cooldownSec = Number(f.cooldown);
      const gridX = Number(f.x);
      const gridY = Number(f.y);

      // Electricity: elecCostPerBlock * blocksPerDay gives daily cost per power unit
      // Convert to hCASH/kWh: (elecCostPerBlock * blocksPerDay) / (1 kW in power units * 24h)
      // 1kW = 10 power units (since 1 unit = 100W)
      const dailyPerUnit = elecCostPerBlock * blocksPerDay;
      const elecRateKwh = (dailyPerUnit * 10) / 24; // hCASH per kWh

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

    // Calculate upgrade costs from contract
    // Index mapping: contract idx 3 = Lv.3 (upgrade cost 1500), idx 4 = Lv.4 (cost 4000)
    // Lv.1 = 2 AVAX, Lv.2 = FREE, Lv.3+ from contract
    const upgradeCosts = [0]; // Lv.1 = 0 hCASH (2 AVAX)
    upgradeCosts.push(0);     // Lv.2 = FREE
    for (let i = 3; i < facResults.length; i++) {
      const cost = Number(facResults[i].cost) / 1e18;
      if (cost > 0 && cost < 1e50) {
        upgradeCosts.push(cost);
      }
    }

    // Calculate cumulative totalHcash
    let cumTotal = 0;
    facilities.forEach((f, i) => {
      if (i < upgradeCosts.length) {
        cumTotal += upgradeCosts[i];
      }
      f.totalHcash = cumTotal;
      f.costAvax = i === 0 ? 2 : 0;
    });

    // ─── Read ALL factory shop miners ───
    const uniqueMiners = Number(await contract.uniqueMinerCount());

    // Get miner registry for names + images
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

    // Minimal ERC721 ABI for totalSupply reads
    const erc721Abi = ["function totalSupply() view returns (uint256)"];

    // Read miners in batches of 8 to avoid public RPC rate limits
    const minerResults = [];
    const BATCH_SIZE = 8;
    for (let start = 1; start <= uniqueMiners; start += BATCH_SIZE) {
      const batch = [];
      for (let i = start; i < start + BATCH_SIZE && i <= uniqueMiners; i++) {
        batch.push(contract.miners(i).then(m => ({ idx: i, m })).catch(() => null));
      }
      const results = await Promise.all(batch);
      results.forEach(r => r && minerResults.push(r));
    }

    // Pre-filter miners we want, then fetch totalSupply for each in parallel batches
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

    // Fetch totalSupply for each candidate (batched to avoid RPC throttling)
    const supplyMap = {};
    for (let start = 0; start < candidateMiners.length; start += BATCH_SIZE) {
      const batch = candidateMiners.slice(start, start + BATCH_SIZE).map(async (cm) => {
        const reg = minerRegistry[cm.idx];
        if (!reg?.nftAddr) return null;
        try {
          const nft = new ethers.Contract(reg.nftAddr, erc721Abi, provider);
          const minted = Number(await nft.totalSupply());
          return { idx: cm.idx, minted };
        } catch { return null; }
      });
      const results = await Promise.all(batch);
      results.forEach(r => { if (r) supplyMap[r.idx] = r.minted; });
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

    const result = {
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

    cache = result;
    cacheTime = now;
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch game data", facilities: [], network: null },
      { status: 500 }
    );
  }
}
