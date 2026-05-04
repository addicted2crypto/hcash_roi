// Registry monitor: polls the HC API /contracts endpoint and records anything new.
// Runs via /api/cron/registry daily (Hobby tier). Writes via storage abstraction:
//   KEYS.REGISTRY_SNAPSHOT — full last-known registry (source of truth for diffing)
//   KEYS.NEW_DROPS         — detected new items, kept for 30 days, served to the frontend
//   KEYS.INTEGRITY_ISSUES  — registry self-consistency failures (via runIntegrityCheck)

import { runIntegrityCheck } from "./registry-integrity.js";
import { getJson, putJson, KEYS } from "./storage.js";

const HC_API = "https://api.hashcash.club/api/v1/public";

const DROP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function loadSnapshot() { return await getJson(KEYS.REGISTRY_SNAPSHOT, null); }
async function loadDrops()    {
  const raw = await getJson(KEYS.NEW_DROPS, null);
  return raw?.drops || [];
}
async function saveSnapshot(contracts) {
  await putJson(KEYS.REGISTRY_SNAPSHOT, {
    capturedAt: new Date().toISOString(),
    contracts,
  });
}
async function saveDrops(drops) {
  await putJson(KEYS.NEW_DROPS, {
    updatedAt: new Date().toISOString(),
    drops,
  });
}

// Pull all registered contracts from the HC API
async function fetchRegistry() {
  const res = await fetch(`${HC_API}/contracts`, {
    headers: { "x-api-key": process.env.HC_API_KEY || "" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HC API /contracts returned ${res.status}`);
  const json = await res.json();
  return json.contracts || [];
}

// Build a normalized drop record from a registry contract entry
function toDrop(c) {
  const drop = {
    id: c.id,
    name: c.name || c.id,
    category: c.category || "unknown",
    address: c.address || null,
    img: c.imageUrl || null,
    detectedAt: new Date().toISOString(),
    // status is intentionally "detected" — the frontend cross-references
    // against live shop/marketplace data to determine "live" vs "upcoming"
    status: "detected",
  };

  // Enrich miner-specific stats
  const ms = c.minerStats;
  if (ms) {
    const hashMhps = ms.hashrateMhps || 0;
    const powerW   = ms.powerWatts   || 0;
    drop.hashrateMhps = hashMhps;
    drop.powerWatts   = powerW;
    drop.efficiency   = powerW > 0 ? +(hashMhps / powerW).toFixed(4) : 0;
    // components = list of required NFTs to assemble (e.g. Octa-TiX2 needs 8×TiX2)
    const raw = ms.components || ms.recipe || ms.ingredients;
    if (raw && (Array.isArray(raw) ? raw.length > 0 : Object.keys(raw).length > 0)) {
      drop.components = raw;
    }
  }

  return drop;
}

export async function checkRegistry() {
  const allContracts = await fetchRegistry();

  const snapshot = await loadSnapshot();
  const prevById = new Map((snapshot?.contracts || []).map(c => [c.id, c]));
  const hasBaseline = prevById.size > 0;

  // Always save the new snapshot regardless of whether we found new items
  await saveSnapshot(allContracts);

  // Always run the integrity validator — gaps must be surfaced even when nothing new
  const integrityReport = await runIntegrityCheck(allContracts);

  // Always check for "launching" miners — miner_nft with address + stats but no
  // address-based mints yet (the on-chain watcher fills in the totalSupply check).
  // Here we record candidates by stats-without-prior-snapshot OR address-but-marked-soon.
  const launchingCandidates = allContracts
    .filter(c => c.category === "miner_nft" && c.address && c.minerStats?.hashrateMhps > 0)
    .filter(c => {
      const prev = prevById.get(c.id);
      // Newly-addressed (registry was incomplete before) OR newly-statted
      return !prev?.address || !prev?.minerStats?.hashrateMhps;
    })
    .map(c => ({
      id: c.id, name: c.name, address: c.address,
      hashrateMhps: c.minerStats.hashrateMhps,
      powerWatts:   c.minerStats.powerWatts,
      img: c.imageUrl || null,
      flaggedAt: new Date().toISOString(),
      reason: !prevById.get(c.id)?.address ? "address_assigned" : "stats_assigned",
    }));

  if (!hasBaseline) {
    // First ever run — seed the snapshot, nothing to alert about yet
    return {
      newDrops: [], totalContracts: allContracts.length, firstRun: true,
      integrityIssues: integrityReport.count,
      launchingCandidates,
    };
  }

  // Find genuinely new entries (IDs not in previous snapshot)
  const newDrops = allContracts
    .filter(c => c.id && !prevById.has(c.id))
    .map(toDrop);

  // Else-branch: nothing brand-new, but maybe something is launching
  // (address now set on a previously-incomplete miner entry, etc.)
  if (newDrops.length === 0 && launchingCandidates.length === 0) {
    return {
      newDrops: [], totalContracts: allContracts.length,
      integrityIssues: integrityReport.count,
      launchingCandidates: [],
    };
  }

  // Merge with existing drops; expire anything older than 30 days; dedupe by id
  const now = Date.now();
  const prevDropsList = await loadDrops();
  const existingDrops = prevDropsList.filter(d =>
    new Date(d.detectedAt).getTime() > now - DROP_TTL_MS &&
    !newDrops.find(nd => nd.id === d.id)
  );

  // Promote launching candidates that aren't already in the drops list to "launching"-tagged drops
  const launchingDrops = launchingCandidates
    .filter(lc => !newDrops.find(nd => nd.id === lc.id) && !existingDrops.find(d => d.id === lc.id))
    .map(lc => ({
      id: lc.id, name: lc.name, category: "miner_nft",
      address: lc.address, img: lc.img,
      hashrateMhps: lc.hashrateMhps, powerWatts: lc.powerWatts,
      efficiency: lc.powerWatts > 0 ? +(lc.hashrateMhps / lc.powerWatts).toFixed(4) : 0,
      detectedAt: new Date().toISOString(),
      status: "launching",
      launchReason: lc.reason,
    }));

  await saveDrops([...newDrops, ...launchingDrops, ...existingDrops]);

  return {
    newDrops, launchingCandidates,
    totalContracts: allContracts.length,
    integrityIssues: integrityReport.count,
    integrityByKind: integrityReport.byKind,
  };
}
