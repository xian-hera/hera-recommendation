/**
 * Incremental training logic
 * Fetches new orders from Shopify Admin API since a given date,
 * runs Apriori, and merges results into existing recommendations
 * using weighted merge (history * historyWeight + new * newDataWeight).
 * After training, queues changed products for metafield sync instead of
 * writing directly (to avoid HTTP timeout).
 */

import { PrismaClient } from "@prisma/client";
import { buildRecommendations } from "./apriori.server.js";

const prisma = new PrismaClient();

// Fetch paid + fulfilled orders from Shopify since a given date
async function fetchNewOrders(admin, sinceDate) {
  const allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  console.log(`Fetching paid+fulfilled orders since: ${sinceDate.toISOString()}`);

  while (hasNextPage) {
    const query = `
      query getOrders($cursor: String) {
        orders(
          first: 250,
          after: $cursor,
          query: "created_at:>=${sinceDate.toISOString()} financial_status:paid fulfillment_status:shipped"
        ) {
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

    const response = await admin.graphql(query, { variables: { cursor } });
    const data = await response.json();
    const orders = data.data?.orders;

    if (!orders) break;

    for (const edge of orders.edges) {
      const node = edge.node;
      const skus = node.lineItems.edges
        .map((e) => e.node.sku)
        .filter((sku) => sku && sku.trim() !== "");

      if (skus.length >= 2) {
        allOrders.push({
          orderId: node.name,
          customerId: node.customer?.id || null,
          skus,
          createdAt: new Date(node.createdAt),
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

// Save new orders to orders table
async function saveOrders(orders) {
  let saved = 0;
  for (const order of orders) {
    await prisma.order.upsert({
      where: { orderId: order.orderId },
      update: { customerId: order.customerId, productIds: order.skus },
      create: {
        orderId: order.orderId,
        customerId: order.customerId,
        productIds: order.skus,
        createdAt: order.createdAt,
      },
    });
    saved++;
  }
  console.log(`Saved ${saved} orders to database.`);
}

// Weighted merge of new recommendations into existing ones
// Returns list of changed SKUs
async function mergeRecommendations(newRecs, historyWeight, newDataWeight) {
  console.log(`Merging recommendations (history: ${historyWeight}, new: ${newDataWeight})...`);
  let updated = 0;
  let created = 0;
  const changedSkus = [];

  for (const [productId, newRecList] of newRecs.entries()) {
    const existing = await prisma.recommendation.findUnique({
      where: { productId },
    });

    if (!existing) {
      await prisma.recommendation.create({
        data: {
          productId,
          recommendedIds: newRecList.map((r) => r.id),
          confidence: newRecList.map((r) => r.confidence * newDataWeight),
          coOccurrenceCount: newRecList.map((r) => r.coOccurrenceCount),
        },
      });
      created++;
      changedSkus.push(productId);
      continue;
    }

    const existingIds = existing.recommendedIds;
    const existingConfidences = existing.confidence;
    const existingCounts = existing.coOccurrenceCount;

    const mergedMap = new Map();
    existingIds.forEach((id, i) => {
      mergedMap.set(id, {
        confidence: (existingConfidences[i] || 0) * historyWeight,
        coOccurrenceCount: existingCounts[i] || 0,
      });
    });

    for (const rec of newRecList) {
      const current = mergedMap.get(rec.id);
      if (current) {
        mergedMap.set(rec.id, {
          confidence: current.confidence + rec.confidence * newDataWeight,
          coOccurrenceCount: current.coOccurrenceCount + rec.coOccurrenceCount,
        });
      } else {
        mergedMap.set(rec.id, {
          confidence: rec.confidence * newDataWeight,
          coOccurrenceCount: rec.coOccurrenceCount,
        });
      }
    }

    const sorted = [...mergedMap.entries()]
      .sort((a, b) => b[1].confidence - a[1].confidence)
      .slice(0, 10);

    await prisma.recommendation.update({
      where: { productId },
      data: {
        recommendedIds: sorted.map(([id]) => id),
        confidence: sorted.map(([, v]) => v.confidence),
        coOccurrenceCount: sorted.map(([, v]) => v.coOccurrenceCount),
      },
    });
    updated++;
    changedSkus.push(productId);
  }

  console.log(`Merge complete: ${created} created, ${updated} updated.`);
  return { created, updated, changedSkus };
}

// Queue changed products for metafield sync
async function queueMetafieldSync(changedSkus) {
  if (changedSkus.length === 0) return 0;

  const skuMappings = await prisma.skuToHandle.findMany({
    where: { sku: { in: changedSkus }, productId: { not: null } },
  });
  const skuToProductMap = Object.fromEntries(
    skuMappings.map((m) => [m.sku, m.productId])
  );

  const recommendations = await prisma.recommendation.findMany({
    where: { productId: { in: changedSkus } },
  });

  const allSkuMappings = await prisma.skuToHandle.findMany({
    where: { productId: { not: null } },
  });
  const allSkuToHandle = Object.fromEntries(
    allSkuMappings.map((m) => [m.sku, m.handle])
  );

  let queued = 0;
  for (const rec of recommendations) {
    const productId = skuToProductMap[rec.productId];
    if (!productId) continue;

    const handles = rec.recommendedIds
      .map((sku) => allSkuToHandle[sku])
      .filter(Boolean);

    if (handles.length === 0) continue;

    await prisma.metafieldSyncQueue.upsert({
      where: {
        id: (await prisma.metafieldSyncQueue.findFirst({
          where: { productId, status: "pending" },
          select: { id: true },
        }))?.id ?? -1,
      },
      update: { handles, attempts: 0, errorMsg: null, status: "pending" },
      create: { productId, handles, status: "pending" },
    });
    queued++;
  }

  console.log(`Queued ${queued} products for metafield sync.`);
  return queued;
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

  const settingsRows = await prisma.setting.findMany();
  const settings = Object.fromEntries(settingsRows.map((s) => [s.key, s.value]));
  const historyWeight = Number(settings["history_weight"] ?? 0.8);
  const newDataWeight = Number(settings["new_data_weight"] ?? 0.2);

  const { syncSkuToHandle } = await import("./sync-sku-handle.server.js");
  await syncSkuToHandle(admin);

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

  // Determine since date
  // For cron, look at last cron training; for manual, look at last manual training
  let sinceDate;
  if (sinceDateOverride) {
    sinceDate = new Date(sinceDateOverride);
    console.log(`Using user-provided since date: ${sinceDate.toISOString()}`);
  } else {
    const lastTraining = await prisma.trainingLog.findFirst({
      where: { triggeredBy, status: "success", errorMsg: null },
      orderBy: { createdAt: "desc" },
    });
    sinceDate = lastTraining
      ? new Date(lastTraining.createdAt)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    console.log(`Auto-detected since date: ${sinceDate.toISOString()}`);
  }

  let ordersCount = 0;

  try {
    const newOrders = await fetchNewOrders(admin, sinceDate);
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
      return { success: true, ordersCount: 0, message: "No new orders found." };
    }

    await saveOrders(newOrders);

    const baskets = newOrders.map((o) => o.skus);
    const newRecs = buildRecommendations(baskets, {
      minSupport: 2,
      minConfidence: 0.01,
      topN: 10,
    });

    const { created, updated, changedSkus } = await mergeRecommendations(
      newRecs,
      historyWeight,
      newDataWeight
    );

    const queued = await queueMetafieldSync(changedSkus);

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
      message: `Training complete. ${ordersCount} orders processed, ${created} new mappings, ${updated} updated, ${queued} queued for metafield sync.`,
    };
  } catch (err) {
    console.error("Incremental training failed:", err);
    await prisma.trainingLog.create({
      data: {
        triggeredBy,
        ordersCount,
        status: "failed",
        durationMs: Date.now() - startTime,
        errorMsg: err.message,
      },
    });
    return { success: false, message: err.message };
  }
}