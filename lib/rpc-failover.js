import { ethers } from "ethers";

// Avalanche C-Chain public RPCs, ranked by observed reliability over Apr 21–24, 2026
// publicnode held up while api.avax.network / drpc / meowrpc were intermittently 503ing
const AVAX_RPCS = [
  "https://avalanche-c-chain-rpc.publicnode.com",
  "https://api.avax.network/ext/bc/C/rpc",
  "https://avalanche.drpc.org",
  "https://avax.meowrpc.com",
  "https://rpc.ankr.com/avalanche",
];

const PER_ENDPOINT_TIMEOUT_MS = 2500;
const MAX_RETRIES_PER_ENDPOINT = 1;

let providerCache = null;

// Lazy single provider per cold start. ethers FallbackProvider has its own
// quorum/scoring logic but rotates too slowly when one endpoint hangs vs hard-fails;
// we instead drive rotation explicitly via withFailover() below.
function getDirectProvider(url) {
  return new ethers.JsonRpcProvider(url, 43114, {
    staticNetwork: ethers.Network.from(43114),
    batchMaxCount: 1,
  });
}

// Single shared provider for the *primary* endpoint — used by callers that
// just want a provider object (e.g. `new ethers.Contract(addr, abi, provider)`).
// Reads issued through this object will NOT failover. Use withFailover() instead
// for anything load-bearing.
export function getProvider() {
  if (!providerCache) providerCache = getDirectProvider(AVAX_RPCS[0]);
  return providerCache;
}

// Run a contract/provider read across endpoints until one succeeds.
// `task(provider)` should return a promise that resolves to the read value.
// Each endpoint gets PER_ENDPOINT_TIMEOUT_MS before we move on.
export async function withFailover(task, { label = "rpc", timeoutMs = PER_ENDPOINT_TIMEOUT_MS } = {}) {
  let lastErr;
  for (const url of AVAX_RPCS) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_ENDPOINT; attempt++) {
      const provider = getDirectProvider(url);
      try {
        return await Promise.race([
          task(provider),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timeout ${label} ${url}`)), timeoutMs)
          ),
        ]);
      } catch (err) {
        lastErr = err;
        // try next attempt or next endpoint
      } finally {
        try { provider.destroy?.(); } catch { /* noop */ }
      }
    }
  }
  throw new Error(`all RPC endpoints failed for ${label}: ${lastErr?.message || "unknown"}`);
}

// Convenience: run an array of independent reads concurrently with shared failover.
// Falls back endpoint-by-endpoint as a unit (not per-call) so we don't fan out
// 20 hitting requests at a sick endpoint.
export async function multiCallFailover(tasks, opts = {}) {
  return withFailover(
    (provider) => Promise.all(tasks.map((t) => t(provider))),
    opts
  );
}

export const RPC_ENDPOINTS = AVAX_RPCS;
