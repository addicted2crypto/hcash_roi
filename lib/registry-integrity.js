// Registry integrity validator: cross-checks the HC API /contracts response
// for self-consistency. Any miner_nft with components MUST have a matching
// rig_assembler entry pointing back to it via outputNftAddress. Any failure
// is recorded as a data-integrity issue — we surface the gap rather than
// fabricating a cost (lesson from the Octa-TiX2 incident).
//
// Output: data/integrity-issues.json (consumed by /api/game and the UI banner).

import fs from "node:fs";
import path from "node:path";

const ISSUES_PATH = path.resolve("data/integrity-issues.json");

// Categorize issues so the UI can color them and so we can rank severity.
const SEVERITY = {
  MISSING_ASSEMBLER: "high",      // assembled rig with no recipe — cost is unknowable
  MISSING_OUTPUT_LINK: "high",    // assembler exists but doesn't link back
  MISSING_ADDRESS: "medium",      // miner marked inProduction but no NFT contract
  COMPONENT_NOT_FOUND: "medium",  // recipe references a component that isn't in the registry
  STATS_MISSING: "low",           // miner_nft with no minerStats
};

function loadIssues() {
  if (!fs.existsSync(ISSUES_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(ISSUES_PATH, "utf8")).issues || []; } catch { return []; }
}

function saveIssues(issues) {
  fs.mkdirSync(path.dirname(ISSUES_PATH), { recursive: true });
  fs.writeFileSync(ISSUES_PATH, JSON.stringify({
    updatedAt: new Date().toISOString(),
    issues,
  }, null, 2));
}

// Return a flat list of {kind, severity, miner, detail} issues for the given registry.
export function validateRegistry(contracts) {
  const issues = [];

  const minersById   = new Map();
  const minersByAddr = new Map();
  const assemblersByOutput = new Map();

  for (const c of contracts || []) {
    if (!c.id) continue;
    if (c.category === "miner_nft") {
      minersById.set(c.id, c);
      if (c.address) minersByAddr.set(c.address.toLowerCase(), c);
    }
    if (c.category === "rig_assembler") {
      const out = (c.outputNftAddress || c.minerStats?.outputNftAddress || "").toLowerCase();
      if (out) assemblersByOutput.set(out, c);
    }
  }

  for (const m of minersById.values()) {
    const ms = m.minerStats;
    const components = ms?.components || ms?.recipe || ms?.ingredients;
    const isAssembled = components && (Array.isArray(components) ? components.length > 0 : Object.keys(components).length > 0);

    // Rule 1: assembled rigs must have a registered assembler
    if (isAssembled) {
      const addr = (m.address || "").toLowerCase();
      const asm = addr ? assemblersByOutput.get(addr) : null;
      if (!asm) {
        issues.push({
          kind: "MISSING_ASSEMBLER",
          severity: SEVERITY.MISSING_ASSEMBLER,
          minerId: m.id,
          minerName: m.name,
          minerAddress: m.address || null,
          detail: `${m.name} (${m.id}) lists components but no rig_assembler in registry has it as outputNftAddress. True cost cannot be computed — the m.cost field is the assembly fee only.`,
        });
      }
    }

    // Rule 2: components referenced must resolve
    if (components && Array.isArray(components)) {
      for (const comp of components) {
        const compAddr = (comp.address || comp.nftAddress || "").toLowerCase();
        const compId   = comp.id || null;
        let resolved = false;
        if (compAddr && minersByAddr.has(compAddr)) resolved = true;
        if (!resolved && compId && minersById.has(compId)) resolved = true;
        if (!resolved && (compAddr || compId)) {
          issues.push({
            kind: "COMPONENT_NOT_FOUND",
            severity: SEVERITY.COMPONENT_NOT_FOUND,
            minerId: m.id,
            minerName: m.name,
            detail: `Component ${compId || compAddr} referenced by ${m.name} not found in miner_nft registry.`,
          });
        }
      }
    }

    // Rule 3: miner with stats but no address (registry incomplete)
    if (ms?.hashrateMhps > 0 && !m.address) {
      issues.push({
        kind: "MISSING_ADDRESS",
        severity: SEVERITY.MISSING_ADDRESS,
        minerId: m.id,
        minerName: m.name,
        detail: `${m.name} (${m.id}) has stats but no NFT contract address — likely upcoming, but registry should populate address before mint.`,
      });
    }

    // Rule 4: miner_nft entry with no stats at all
    if (!ms || (ms.hashrateMhps == null && ms.powerWatts == null)) {
      issues.push({
        kind: "STATS_MISSING",
        severity: SEVERITY.STATS_MISSING,
        minerId: m.id,
        minerName: m.name,
        detail: `${m.name} (${m.id}) is in miner_nft category but has no minerStats — efficiency unknowable.`,
      });
    }
  }

  // Rule 5: assemblers pointing to non-existent miners
  for (const [outputAddr, asm] of assemblersByOutput) {
    if (!minersByAddr.has(outputAddr)) {
      issues.push({
        kind: "MISSING_OUTPUT_LINK",
        severity: SEVERITY.MISSING_OUTPUT_LINK,
        minerId: asm.id,
        minerName: asm.name,
        detail: `Assembler ${asm.name} (${asm.id}) outputs to ${outputAddr} but no miner_nft has that address.`,
      });
    }
  }

  return issues;
}

// Run validation, persist, and return.
export function runIntegrityCheck(contracts) {
  const issues = validateRegistry(contracts);
  saveIssues(issues);
  return { issues, count: issues.length, byKind: tally(issues) };
}

export function loadIntegrityIssues() {
  return loadIssues();
}

function tally(issues) {
  const out = {};
  for (const i of issues) out[i.kind] = (out[i.kind] || 0) + 1;
  return out;
}
