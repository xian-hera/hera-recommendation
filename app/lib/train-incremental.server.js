/**
 * Incremental training logic
 * Fetches new orders from Shopify Admin API since a given date,
 * runs Apriori, and merges results into existing recommendations
 * using weighted merge (history * historyWeight + new * newDataWeight).
 * After training, queues changed products for metafield sync instead of
 * writing directly (to avoid HTTP timeout).
 *
 * 2026-10-29 — fix for the nightly "Exited with status 134" crashes
 * (Render alert emails ~3:20 ET every day; log showed
 * "Saved 232636 orders" → "Starting training with 232636 orders" →
 * "JavaScript heap out of memory" at ~224 MB heap):
 *
 *  1. The lookback window is now bounded. The since-date used to come only
 *     from the last cron run that succeeded with errorMsg === null, and a
 *     run that crashes never writes a log row — so once one run died, every
 *     following night re-fetched an ever-growing range (≈ the whole order
 *     history) and died again. Now: watermark = last successful run of the
 *     same trigger type that actually looked at orders (including "No new
 *     orders found"), clamped to MAX_AUTO_LOOKBACK_DAYS; a manual start date
 *     is clamped to MAX_MANUAL_LOOKBACK_DAYS. The date in the Shopify search
 *     query is also quoted now, as Shopify's search syntax expects.
 *  2. Active-only: SKU sync only keeps ACTIVE products (see
 *     sync-sku-handle.server.js); training ignores SKUs that aren't active,
 *     and the weighted merge drops existing rules that point at
 *     non-active SKUs.
 *  3. Memory/round trips: integer-based pair counting (apriori.server.js),
 *     chunked multi-row writes (bulk-db.server.js) instead of one Prisma
 *     call per row, and the fetched order list is released before training.
 *
 * Shares the db.server.js Prisma singleton (see 2026-09-28 notes in
 * concurrency.server.js).
 */

import prisma from "../db.server.js";
import { buildRecommendations } from "./apriori.server.js";
import { mapWithConcurrencyLimit, DEFAULT_CONCURRENCY } from "./concurrency.server.js";
import { upsertOrders, upsertRecommendations } from "./bulk-db.server.js";
import { invalidateRecommendCaches } from "./recommend-cache.server.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Automatic runs (cron, or manual with no date) never look back further
// than this, even if the last success was long ago or never happened.
export const MAX_AUTO_LOOKBACK_DAYS = 14;
// A start date picked by hand on the Training page is clamped to this.
export const MAX_MANUAL_LOOKBACK_DAYS = 120;

// Fetch paid + fulfilled orders from Shopify since a given date
async function fetchNewOrders(admin, sinceDate) {
  const allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  console.log(`Fetching paid+fulfilled orders since: ${sinceDate.toISOString()}`);

  while (hasNextPage) {
    const query = `
      query getOrders($cursor: String, $search: String) {
        orders(first: 250, after: $cursor, query: $search) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              name
              createdAt
              customer {
                id
              }
              lineItems(first: 50) {
                edges {
                  node {
                    sku
                  }
                }
              }
            }
          }
        }
      }
    `;

    const search = `created_at:>='${sinceDate.toISOString()}' financial_status:paid fulfillment_status:shipped`;
    const response = await admin.graphql(query, { variables: { cursor, search } });
    const data = await response.json();
    const orders = data.data?.orders;

    if (!orders) {
      throw new Error(
        `Shopify orders query failed: ${JSON.stringify(data.errors ?? data).slice(0, 300)}`
      );
    }

    for (const edge of orders.edges) {
      const node = edge.node;
      // Defensive: never trust the search filter alone for the date range.
      const createdAt = new Date(node.createdAt);
      if (createdAt < sinceDate) continue;

      const skus = node.lineItems.edges
        .map((e) => e.node.sku?.trim())
        .filter(Boolean);

      if (skus.length >= 2) {
        allOrders.push({
          orderId: node.name,
          customerId: node.customer?.id || null,
          skus,
          createdAt,
        });
      }
    }

    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
    console.log(`Fetched ${allOrders.length} orders so far...`);
  }

  console.log(`Total new orders fetched: ${allOrders.length}`);
  return allOrders;
}

// Weighted merge of new recommendations into existing ones.
// Existing rules pointing at SKUs that are no longer active are dropped.
// Returns list of changed SKUs.
async function mergeRecommendations(newRecs, historyWeight, newDataWeight, activeSkus) {
  console.log(`Merging recommendations (history: ${historyWeight}, new: ${newDataWeight})...`);
  let updated = 0;
  let created = 0;
  const changedSkus = [];
  const entries = [...newRecs.entries()];
  const LOOKUP_CHUNK = 1000;

  for (let i = 0; i < entries.length; i += LOOKUP_CHUNK) {
    const chunk = entries.slice(i, i + LOOKUP_CHUNK);
    const existingRows = await prisma.recommendation.findMany({
      where: { productId: { in: chunk.map(([productId]) => productId) } },
    });
    const existingBySku = new Map(existingRows.map((r) => [r.productId, r]));

    const writes = [];
    for (const [productId, newRecList] of chunk) {
      const existing = existingBySku.get(productId);
      const mergedMap = new Map();

      if (existing) {
        const ids = Array.isArray(existing.recommendedIds) ? existing.recommendedIds : [];
        ids.forEach((id, idx) => {
          if (!activeSkus.has(id)) return; // no longer sellable
          mergedMap.set(id, {
            confidence: (existing.confidence[idx] || 0) * historyWeight,
            coOccurrenceCount: existing.coOccurrenceCount[idx] || 0,
          });
        });
      }

      for (const rec of newRecList) {
        const current = mergedMap.get(rec.id);
        mergedMap.set(rec.id, {
          confidence: (current?.confidence || 0) + rec.confidence * newDataWeight,
          coOccurrenceCount: (current?.coOccurrenceCount || 0) + rec.coOccurrenceCount,
        });
      }

      const sorted = [...mergedMap.entries()]
        .sort((a, b) => b[1].confidence - a[1].confidence)
        .slice(0, 10);

      writes.push({
        productId,
        recommendedIds: sorted.map(([id]) => id),
        confidence: sorted.map(([, v]) => v.confidence),
        coOccurrenceCount: sorted.map(([, v]) => v.coOccurrenceCount),
      });
      if (existing) updated++;
      else created++;
      changedSkus.push(productId);
    }

    await upsertRecommendations(writes);
  }

  console.log(`Merge complete: ${created} created, ${updated} updated.`);
  return { created, updated, changedSkus };
}

// Queue changed products for metafield sync.
// Several SKUs (variants) can belong to the same Shopify product; their
// recommendation handles are combined into ONE queue entry per product
// (ranked order kept, de-duplicated, product's own handle excluded, max 10),
// which also removes the duplicate-row race noted in the previous version.
async function queueMetafieldSync(changedSkus) {
  if (changedSkus.length === 0) return 0;

  const allSkuMappings = await prisma.skuToHandle.findMany({
    where: { productId: { not: null } },
    select: { sku: true, handle: true, productId: true },
  });
  const skuInfo = new Map(allSkuMappings.map((m) => [m.sku, m]));

  const handlesByProduct = new Map(); // productId -> { ownHandle, handles: [] }
  const LOOKUP_CHUNK = 1000;
  for (let i = 0; i < changedSkus.length; i += LOOKUP_CHUNK) {
    const recs = await prisma.recommendation.findMany({
      where: { productId: { in: changedSkus.slice(i, i + LOOKUP_CHUNK) } },
      select: { productId: true, recommendedIds: true },
    });
    for (const rec of recs) {
      const source = skuInfo.get(rec.productId);
      if (!source) continue; // source SKU not active
      let entry = handlesByProduct.get(source.productId);
      if (!entry) {
        entry = { ownHandle: source.handle, handles: [] };
        handlesByProduct.set(source.productId, entry);
      }
      for (const sku of rec.recommendedIds) {
        const h = skuInfo.get(sku)?.handle;
        if (h && h !== entry.ownHandle && !entry.handles.includes(h)) entry.handles.push(h);
      }
    }
  }

  const items = [...handlesByProduct.entries()]
    .map(([productId, { handles }]) => ({ productId, handles: handles.slice(0, 10) }))
    .filter((it) => it.handles.length > 0);
  if (items.length === 0) return 0;

  const pendingRows = await prisma.metafieldSyncQueue.findMany({
    where: { status: "pending", productId: { in: items.map((it) => it.productId) } },
    select: { id: true, productId: true },
  });
  const pendingIdByProduct = new Map(pendingRows.map((r) => [r.productId, r.id]));

  const toCreate = items.filter((it) => !pendingIdByProduct.has(it.productId));
  const toUpdate = items.filter((it) => pendingIdByProduct.has(it.productId));

  for (let i = 0; i < toCreate.length; i += 1000) {
    await prisma.metafieldSyncQueue.createMany({
      data: toCreate.slice(i, i + 1000).map((it) => ({
        productId: it.productId,
        handles: it.handles,
        status: "pending",
      })),
    });
  }
  await mapWithConcurrencyLimit(toUpdate, DEFAULT_CONCURRENCY, (it) =>
    prisma.metafieldSyncQueue.update({
      where: { id: pendingIdByProduct.get(it.productId) },
      data: { handles: it.handles, attempts: 0, errorMsg: null },
    })
  );

  console.log(`Queued ${items.length} products for metafield sync.`);
  return items.length;
}

/**
 * Work out where this run starts reading orders from.
 * Exported for testing.
 */
export async function resolveSinceDate(triggeredBy, sinceDateOverride, now = new Date()) {
  if (sinceDateOverride) {
    const requested = new Date(sinceDateOverride);
    if (Number.isNaN(requested.getTime())) {
      throw new Error(`Invalid start date: ${sinceDateOverride}`);
    }
    const floor = new Date(now.getTime() - MAX_MANUAL_LOOKBACK_DAYS * DAY_MS);
    if (requested < floor) {
      console.warn(
        `Requested start date ${requested.toISOString()} is more than ${MAX_MANUAL_LOOKBACK_DAYS} days ago; using ${floor.toISOString()}.`
      );
      return { sinceDate: floor, clamped: true };
    }
    console.log(`Using user-provided since date: ${requested.toISOString()}`);
    return { sinceDate: requested, clamped: false };
  }

  // Last run of the same trigger type that actually checked for orders —
  // including runs that found none. Excludes "Sync only" runs.
  const lastTraining = await prisma.trainingLog.findFirst({
    where: {
      triggeredBy,
      status: "success",
      OR: [{ errorMsg: null }, { NOT: { errorMsg: { startsWith: "Sync only" } } }],
    },
    orderBy: { createdAt: "desc" },
  });

  const floor = new Date(now.getTime() - MAX_AUTO_LOOKBACK_DAYS * DAY_MS);
  const fromLog = lastTraining ? new Date(lastTraining.createdAt) : null;
  if (!fromLog || fromLog < floor) {
    console.log(
      `Auto since date: ${floor.toISOString()} (capped at ${MAX_AUTO_LOOKBACK_DAYS} days; last success: ${fromLog?.toISOString() ?? "none"})`
    );
    return { sinceDate: floor, clamped: Boolean(fromLog) };
  }
  console.log(`Auto-detected since date: ${fromLog.toISOString()}`);
  return { sinceDate: fromLog, clamped: false };
}

/**
 * Main incremental training function
 * @param {object} admin - Shopify admin API client
 * @param {string|null} sinceDateOverride - ISO date string to override since date
 * @param {boolean} syncOnly - If true, only sync SKU->handle mapping
 * @param {string} triggeredBy - 'manual' | 'cron'
 */
export async function runIncrementalTraining(
  admin,
  sinceDateOverride = null,
  syncOnly = false,
  triggeredBy = "manual"
) {
  const startTime = Date.now();
  let ordersCount = 0;

  try {
    const settingsRows = await prisma.setting.findMany();
    const settings = Object.fromEntries(settingsRows.map((s) => [s.key, s.value]));
    const historyWeight = Number(settings["history_weight"] ?? 0.8);
    const newDataWeight = Number(settings["new_data_weight"] ?? 0.2);

    const { syncSkuToHandle, getActiveSkuSet } = await import("./sync-sku-handle.server.js");
    await syncSkuToHandle(admin);
    invalidateRecommendCaches(); // active-SKU set may have changed

    if (syncOnly) {
      await prisma.trainingLog.create({
        data: {
          triggeredBy,
          ordersCount: 0,
          status: "success",
          durationMs: Date.now() - startTime,
          errorMsg: "Sync only — no training performed.",
        },
      });
      return { success: true, ordersCount: 0, message: "SKU to handle sync complete." };
    }

    const { sinceDate, clamped } = await resolveSinceDate(triggeredBy, sinceDateOverride);
    const clampNote = clamped ? ` (start date capped to ${sinceDate.toISOString().slice(0, 10)})` : "";

    let newOrders = await fetchNewOrders(admin, sinceDate);
    ordersCount = newOrders.length;

    if (ordersCount === 0) {
      console.log("No new orders found, skipping training.");
      await prisma.trainingLog.create({
        data: {
          triggeredBy,
          ordersCount: 0,
          status: "success",
          durationMs: Date.now() - startTime,
          errorMsg: "No new orders found.",
        },
      });
      return { success: true, ordersCount: 0, message: `No new orders found.${clampNote}` };
    }

    const savedCount = await upsertOrders(newOrders);
    console.log(`Saved ${savedCount} orders to database.`);

    const baskets = newOrders.map((o) => o.skus);
    newOrders = null; // let GC reclaim order objects before training

    const activeSkus = await getActiveSkuSet();
    console.log(`Active SKUs: ${activeSkus.size}`);

    const newRecs = buildRecommendations(baskets, {
      minSupport: 2,
      minConfidence: 0.01,
      topN: 10,
      allowedSkus: activeSkus,
    });
    baskets.length = 0;

    const { created, updated, changedSkus } = await mergeRecommendations(
      newRecs,
      historyWeight,
      newDataWeight,
      activeSkus
    );

    const queued = await queueMetafieldSync(changedSkus);
    invalidateRecommendCaches(); // popular-products fallback reflects the new model

    await prisma.trainingLog.create({
      data: {
        triggeredBy,
        ordersCount,
        status: "success",
        durationMs: Date.now() - startTime,
      },
    });

    return {
      success: true,
      ordersCount,
      created,
      updated,
      queued,
      message: `Training complete${clampNote}. ${ordersCount} orders processed, ${created} new mappings, ${updated} updated, ${queued} queued for metafield sync.`,
    };
  } catch (err) {
    console.error("Incremental training failed:", err);
    await prisma.trainingLog.create({
      data: {
        triggeredBy,
        ordersCount,
        status: "failed",
        durationMs: Date.now() - startTime,
        errorMsg: String(err.message).slice(0, 1000),
      },
    });
    return { success: false, message: err.message };
  }
}
