/**
 * In-process caches for /api/recommend.
 *
 * Added 2026-10-29. Storefront calls with no product/customer/viewed signal
 * (e.g. `/api/recommend?shop=...&count=10`, the most common call on the
 * homepage) fell straight through to the "popular products" fallback query,
 * which unnests and aggregates the WHOLE recommendations table on every
 * request — Render logs showed these taking 3.5–8.6 s each. That ranking
 * only changes when training runs, so it is computed once and reused.
 *
 * Single Render instance → a module-level cache is enough. Concurrent
 * requests during a refresh share the same in-flight promise.
 */

import prisma from "../db.server.js";

const SETTINGS_TTL_MS = 60 * 1000;          // admin setting changes show up within a minute
const POPULAR_TTL_MS = 30 * 60 * 1000;      // recomputed at most every 30 min
const POPULAR_POOL_SIZE = 300;              // distinct products kept for fallback

function cached(ttlMs, load) {
  let value = null;
  let expiresAt = 0;
  let inFlight = null;

  async function get() {
    if (value && Date.now() < expiresAt) return value;
    if (inFlight) return inFlight;
    inFlight = load()
      .then((v) => {
        value = v;
        expiresAt = Date.now() + ttlMs;
        return v;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }
  get.invalidate = () => {
    value = null;
    expiresAt = 0;
  };
  return get;
}

export const getSettingsCached = cached(SETTINGS_TTL_MS, async () => {
  const rows = await prisma.setting.findMany();
  return Object.fromEntries(rows.map((s) => [s.key, s.value]));
});

/**
 * Site-wide fallback pool: products that appear most often across all
 * trained rules, one row per product handle (best SKU for that handle),
 * active SKUs only (inner join on sku_to_handle).
 */
export const getPopularPoolCached = cached(POPULAR_TTL_MS, async () => {
  const started = Date.now();
  const rows = await prisma.$queryRaw`
    WITH sku_counts AS (
      SELECT rec_sku, COUNT(*) AS rec_count
      FROM recommendations r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.recommended_ids) AS rec_sku
      GROUP BY rec_sku
    ),
    handle_counts AS (
      SELECT
        s.handle,
        s.title,
        sc.rec_sku AS top_sku,
        sc.rec_count,
        ROW_NUMBER() OVER (PARTITION BY s.handle ORDER BY sc.rec_count DESC) AS rn
      FROM sku_counts sc
      INNER JOIN sku_to_handle s ON s.sku = sc.rec_sku
    )
    SELECT handle, title, top_sku
    FROM handle_counts
    WHERE rn = 1
    ORDER BY rec_count DESC
    LIMIT ${POPULAR_POOL_SIZE}
  `;
  console.log(`Popular fallback pool refreshed: ${rows.length} products in ${Date.now() - started} ms`);
  return rows.map((r) => ({ handle: r.handle, title: r.title ?? null, sku: r.top_sku }));
});

/** Call after training / SKU sync so the next request sees fresh data. */
export function invalidateRecommendCaches() {
  getSettingsCached.invalidate();
  getPopularPoolCached.invalidate();
}
