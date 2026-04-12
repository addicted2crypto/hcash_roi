import { ethers } from "ethers";
import { NextResponse } from "next/server";

const AVAX_RPC   = "https://api.avax.network/ext/bc/C/rpc";
const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const HC_API     = "https://api.hashcash.club/api/v1/public";
const HC_API_KEY = process.env.HC_API_KEY || "";

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000;

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

    const [totalHashrate, blocksUntilHalving, bigcoinPerBlock, facilityCount] =
      await Promise.all([
        contract.totalHashrate(),
        contract.blocksUntilNextHalving(),
        contract.getBigcoinPerBlock(),
        contract.facilityCount(),
      ]);

    const netHash = Number(totalHashrate);
    const halvingBlocks = Number(blocksUntilHalving);
    const emission = Number(bigcoinPerBlock) / 1e18;
    const facCount = Number(facilityCount);
    const blocksPerDay = Math.floor(86400 / 1.05);
    const halvingDays = Math.round(halvingBlocks / blocksPerDay);

    // Read all facility configs
    const facPromises = [];
    for (let i = 0; i < facCount; i++) {
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
