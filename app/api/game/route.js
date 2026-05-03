import { ethers } from "ethers";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { withFailover } from "@/lib/rpc-failover.js";
import { withSWR } from "@/lib/swr-cache.js";
import { rateLimit, getClientIp, tooManyRequests } from "@/lib/rate-limit.js";
import { loadIntegrityIssues } from "@/lib/registry-integrity.js";
import { fireStaleCronsInBackground } from "@/lib/fire-if-stale.js";

const GAME_MAIN  = "0x105fecae0c48d683dA63620De1f2d1582De9e98a";
const HC_API     = "https://api.hashcash.club/api/v1/public";
const HC_API_KEY = process.env.HC_API_KEY || "";

const COSTS_PATH = path.resolve("data/cost-changes.json");

function loadRecentCostChanges() {
  if (!fs.existsSync(COSTS_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(COSTS_PATH, "utf8"));
    return (raw.changes || []).slice(0, 10);
  } catch { return []; }
}

const CACHE_TTL = 2 * 60 * 1000;

// Block-time measurement cached separately (rarely changes, refresh hourly)
let blockTimeCache = { blocksPerDay: 85325, measuredAt: 0 };
const BLOCK_TIME_TTL = 60 * 60 * 1000;

export async function GET(req) {
  if (!rateLimit(getClientIp(req), { maxReqs: 20, windowMs: 60_000 })) return tooManyRequests();
  // Organic cron-bypass: if watcher/registry data is stale, fire those routes
  // in the background. Does NOT block this response. Heavy dedupe in the helper.
  fireStaleCronsInBackground(req);
  try {
    const { data, stale, ageMs } = await withSWR("game", CACHE_TTL, async () => {
      const abiRes = await fetch(HC_API + "/abis/main.v1.json", {
        headers: { "x-api-key": HC_API_KEY },
      }).then((r) => r.json());

      // ─── Top-level network reads ───
      const top = await withFailover(async (provider) => {
        const contract = new ethers.Contract(GAME_MAIN, abiRes.abi, provider);
        const [totalHashrate, bigcoinPerBlock, initialBigcoinPerBlock, facilityCount,
               latestBlockNum, startBlock, halvingInterval] =
          await Promise.all([
            contract.totalHashrate(),
            contract.getBigcoinPerBlock(),
            contract.INITIAL_BIGCOIN_PER_BLOCK(),
            contract.facilityCount(),
            provider.getBlockNumber(),
            contract.startBlock(),
            contract.HALVING_INTERVAL(),
          ]);
        return { totalHashrate, bigcoinPerBlock, initialBigcoinPerBlock,
                 facilityCount, latestBlockNum, startBlock, halvingInterval };
      }, { label: "top", timeoutMs: 4000 });

      const netHash        = Number(top.totalHashrate);
      const facCount       = Number(top.facilityCount);
      const latestBlockNum = Number(top.latestBlockNum);

      // ─── Halving schedule — derived from first principles, not blocksUntilNextHalving() ───
      // The contract's blocksUntilNextHalving() is off by one interval; we own this math.
      // Self-correcting: halvingsPassed increments automatically as blocks advance.
      const startBlock      = Number(top.startBlock);
      const halvingInterval = Number(top.halvingInterval);
      const currentBlockN   = latestBlockNum;
      const halvingsPassed  = Math.floor((currentBlockN - startBlock) / halvingInterval);
      const nextHalvingBlock = startBlock + (halvingsPassed + 1) * halvingInterval;
      const halvingBlocks   = nextHalvingBlock - currentBlockN;

      // Cross-check emission: compute from INITIAL_BIGCOIN_PER_BLOCK / 2^halvingsPassed.
      // If the contract's getBigcoinPerBlock() hasn't lazily updated yet (e.g. no one has
      // claimed rewards since the halving block passed), use our computed value instead.
      const initialEmission   = Number(top.initialBigcoinPerBlock) / 1e18;
      const computedEmission  = initialEmission / Math.pow(2, halvingsPassed);
      const contractEmission  = Number(top.bigcoinPerBlock) / 1e18;
      // Take the lower — contract can only be stale-high, never stale-low
      const emission = Math.min(contractEmission, computedEmission);

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

      const halvingDays = +(halvingBlocks / blocksPerDay).toFixed(2);

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

      // Index ALL categories — miner_nft for the shop, everything else for new-drop detection
      const registryCategories = {};
      const minerRegistry = {};
      (reg.contracts || []).forEach((c) => {
        const cat = c.category || "unknown";
        if (!registryCategories[cat]) registryCategories[cat] = [];
        registryCategories[cat].push({ name: c.name, id: c.id, img: c.imageUrl || "", address: c.address || null });
        if (cat === "miner_nft") {
          const idx = parseInt(c.id.replace("miner_nft:", ""), 10);
          if (!isNaN(idx)) {
            minerRegistry[idx] = { name: c.name, img: c.imageUrl || "", stats: c.minerStats, nftAddr: c.address };
          }
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

      // Build a lookup of integrity issues by miner address — used to mark
      // assembled rigs whose true cost is unknowable from the contract alone.
      const integrityIssues = loadIntegrityIssues();
      const issuesByMinerId = new Map();
      for (const i of integrityIssues) {
        if (!i.minerId) continue;
        const arr = issuesByMinerId.get(i.minerId) || [];
        arr.push(i);
        issuesByMinerId.set(i.minerId, arr);
      }

      const shopMiners = candidateMiners.map(cm => {
        const regEntry = minerRegistry[cm.idx];
        const minted = supplyMap[cm.idx] ?? 0;
        const remaining = Math.max(0, cm.maxSupply - minted);
        const stats = regEntry?.stats || {};
        const components = stats.components || stats.recipe || stats.ingredients || null;
        const isAssembled = !!components && (Array.isArray(components) ? components.length > 0 : Object.keys(components).length > 0);

        // Honest cost reporting: if the rig is assembled and has integrity issues,
        // we DO NOT publish the partial cost. We mark it as `costUnknown` so the
        // UI can render "cost incomplete — registry gap" instead of a wrong number.
        const regId = `miner_nft:${cm.idx}`;
        const issues = issuesByMinerId.get(regId) || [];
        const hasMissingAssembler = issues.some(i => i.kind === "MISSING_ASSEMBLER");
        const costUnknown = isAssembled && hasMissingAssembler;

        return {
          minerIndex: cm.idx,
          id: `miner${cm.idx}`,
          name: regEntry?.name || `Miner #${cm.idx}`,
          hash: cm.hash,
          powerW: cm.powerW,
          // Only publish costHcash if we trust it. Assembled-with-missing-recipe
          // returns null so the UI can't render a misleading number.
          costHcash: costUnknown ? null : Math.round(cm.costRaw),
          assemblyFeeOnly: costUnknown ? Math.round(cm.costRaw) : null,
          avaxCost: cm.avaxCostRaw > 0 ? +cm.avaxCostRaw.toFixed(4) : 0,
          inProduction: cm.inProd,
          maxSupply: cm.maxSupply,
          minted,
          remaining,
          soldOut: remaining === 0,
          img: regEntry?.img || "",
          stats: Object.keys(stats).length > 0 ? stats : null,
          components,
          isAssembled,
          costUnknown,
          integrityIssues: issues.map(i => ({ kind: i.kind, severity: i.severity, detail: i.detail })),
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
        registryCategories,
        integrityIssues,
        recentCostChanges: loadRecentCostChanges(),
        updatedAt: new Date().toISOString(),
      };
    });

    return NextResponse.json({ ...data, stale, ageMs }, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=120" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch game data", facilities: [], network: null },
      { status: 500 }
    );
  }
}
