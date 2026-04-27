// Tiny per-route stale-while-revalidate helper.
// Holds the last successful response per key in module memory and serves it
// (with a `staleAt` timestamp) when a fresh fetch fails. The UI can show an
// amber "X min stale" indicator instead of going blank.

const stores = new Map();

function getStore(key) {
  let s = stores.get(key);
  if (!s) {
    s = { fresh: null, freshAt: 0, lastGood: null, lastGoodAt: 0 };
    stores.set(key, s);
  }
  return s;
}

export async function withSWR(key, ttlMs, fetcher) {
  const store = getStore(key);
  const now = Date.now();

  if (store.fresh && now - store.freshAt < ttlMs) {
    return { data: store.fresh, stale: false, ageMs: now - store.freshAt };
  }

  try {
    const data = await fetcher();
    store.fresh = data;
    store.freshAt = now;
    store.lastGood = data;
    store.lastGoodAt = now;
    return { data, stale: false, ageMs: 0 };
  } catch (err) {
    if (store.lastGood) {
      return {
        data: store.lastGood,
        stale: true,
        ageMs: now - store.lastGoodAt,
        error: err?.message || String(err),
      };
    }
    throw err;
  }
}
