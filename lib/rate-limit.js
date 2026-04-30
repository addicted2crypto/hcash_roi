// In-memory sliding-window rate limiter.
// Primary cost protection is Cache-Control (CDN caching eliminates function invocations).
// This is defense-in-depth: catches burst hammering within a single warm instance.
// Resets on cold start — that's fine; cold starts are rare and already costly per Vercel billing.

const store = new Map(); // ip -> number[] (timestamps within current window)

export function rateLimit(ip, { maxReqs = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const key = ip || "unknown";
  const timestamps = (store.get(key) || []).filter(t => now - t < windowMs);
  timestamps.push(now);
  store.set(key, timestamps);
  // Prune dead entries periodically so memory doesn't grow unbounded
  if (store.size > 5000) {
    for (const [k, ts] of store) {
      if (ts.every(t => now - t >= windowMs)) store.delete(k);
    }
  }
  return timestamps.length <= maxReqs;
}

export function getClientIp(req) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function tooManyRequests() {
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });
}
