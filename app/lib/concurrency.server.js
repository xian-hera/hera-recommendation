/**
 * Shared bounded-concurrency helper.
 *
 * Added 2026-09-28 after /api/cron/train crashed the whole web service
 * (Render alert: "Exited with status 134" — SIGABRT, the signature Node.js
 * leaves when it aborts on an unrecoverable condition, most commonly a V8
 * out-of-memory abort). The cron job's own log showed the request sitting at
 * 0 bytes received for over 10 minutes before the connection was reset —
 * i.e. the server never even started writing a response, consistent with it
 * still being deep inside a long synchronous chain of work when it went
 * down.
 *
 * Root cause: syncSkuToHandle (sync-sku-handle.server.js) — which
 * runIncrementalTraining calls FIRST, on every single training run, cron or
 * manual — upserts one row per SKU variant in a plain sequential
 * `for (...) { await prisma.skuToHandle.upsert(...) }` loop, with zero
 * batching or rate limiting. At Hera's real catalog size (10,000+ SKUs —
 * same store, same scale problem already found and fixed in
 * hera-analytics's aggregation.server.ts/sync.server.ts this same week),
 * that's 10,000+ one-at-a-time DB round trips before training even starts
 * looking at orders. train-incremental.server.js has three more loops of
 * the exact same shape (saveOrders, mergeRecommendations,
 * queueMetafieldSync) — a single training run could easily be doing many
 * thousands of fully serial round trips in one HTTP request, which is both
 * why it ran for 10+ minutes and a very plausible way to make the process's
 * memory footprint climb for that whole time (accumulating orders/baskets/
 * recommendation maps in memory on top of whatever normal web traffic the
 * same process was also serving) until it hit a limit.
 *
 * This does N operations at a time instead of 1 or "all at once" — same
 * pattern as hera-analytics's mapWithConcurrencyLimit. It doesn't remove the
 * work, but it cuts wall-clock time by roughly the concurrency factor and
 * caps how many DB round trips (and their associated connections/memory)
 * are in flight at once, instead of an unbounded queue of thousands.
 */
export async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// Shared default cap — conservative enough to leave headroom on a small
// Postgres connection pool while still being many times faster than fully
// serial. Not a hard rule; callers can pass their own limit.
export const DEFAULT_CONCURRENCY = 8;
