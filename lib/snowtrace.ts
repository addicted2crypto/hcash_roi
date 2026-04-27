// Snowtrace URL helpers. Used everywhere we want to surface "verify on-chain ↗"
// links so users can re-execute the read themselves and confirm our numbers.
//
// All numbers on /profitability and /wallet/[address] should carry one of these.

export const SNOWTRACE = {
  // Address overview page
  contract: (a: string) => `https://snowtrace.io/address/${a}`,

  // Read-tab on a verified contract — drops the user on the function panel where
  // they can paste an address and re-run the call. The fragment is a
  // best-effort hint; not every Snowtrace version honors it, but the page is
  // still correct.
  read: (a: string, fn: string) => `https://snowtrace.io/address/${a}#readContract`,

  // Single tx
  tx: (h: string) => `https://snowtrace.io/tx/${h}`,

  // ERC20 transfer history filtered by address — the right link for "where did
  // this hCASH come from / go to" claims.
  tokenTransfers: (token: string, addr: string) =>
    `https://snowtrace.io/token/${token}?a=${addr}`,

  // Address page filtered to internal txs — useful for tracing AVAX flows
  internalTxs: (a: string) => `https://snowtrace.io/address/${a}#internaltx`,

  // Block view — for "scanned at block X" footer claims
  block: (n: number) => `https://snowtrace.io/block/${n}`,
};

// Canonical contract addresses — same constants used by the scan module
export const CONTRACTS = {
  GAME_MAIN:   "0x105fecae0c48d683dA63620De1f2d1582De9e98a",
  MARKETPLACE: "0x511FC8b8e5D07a012D17f56fE8bfdE576c8Dd13d",
  HCASH_TOKEN: "0xba5444409257967e5e50b113c395a766b0678c03",
  PHARAOH_PAIR:"0x8F961980518BC9ab302948De7948580666dc35D9",
} as const;

// Truncate `0xABCD…1234` for display
export function truncAddr(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length < head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

// Validate hex address (used by /wallet/[address] route)
export function isValidAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}
