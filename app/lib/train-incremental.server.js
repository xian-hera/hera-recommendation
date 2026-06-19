/**
 * Incremental training logic
 * Fetches new orders from Shopify Admin API since last training,
 * runs Apriori, and merges results into existing recommendations
 * using weighted merge (history * historyWeight + new * newDataWeight).
 */

import { PrismaClient } from "@prisma/client";
import { buildRecommendations } from "./apriori.server.js";

const prisma = new PrismaClient();

// Fetch new orders from Shopify since a given date
async function fetchNewOrders(admin, sinceDate) {
  const allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  console.log(`Fetching orders since: ${sinceDate.toISOString()}`);

  while (hasNextPage) {
    const query = `
      query getOrders($cursor: String, $since: DateTime!) {
        orders(first: 250, after: $cursor, query: "created_at:>=${sinceDate.toISOString()}") {
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

    const response = await admin.graphql(query, {
      variables: { cursor, since: sinceDate },
    });

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
      update: {
        customerId: order.customerId,
        productIds: order.skus,
      },
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
async function mergeRecommendations(newRecs, historyWeight, newDataWeight) {
  console.log(`Merging recommendations (history: ${historyWeight}, new: ${newDataWeight})...`);
  let updated = 0;
  let created = 0;

  for (const [productId, newRecList] of newRecs.entries()) {
    const existing = await prisma.recommendation.findUnique({
      where: { productId },
    });

    if (!existing) {
      // New product, just insert
      await prisma.recommendation.create({
        data: {
          productId,
          recommendedIds: newRecList.map((r) => r.id),
          confidence: newRecList.map((r) => r.confidence * newDataWeight),
          coOccurrenceCount: newRecList.map((r) => r.coOccurrenceCount),
        },
      });
      created++;
      continue;
    }

    // Merge existing with new
    const existingIds = existing.recommendedIds;
    const existingConfidences = existing.confidence;
    const existingCounts = existing.coOccurrenceCount;

    // Build map from existing data
    const mergedMap = new Map();
    existingIds.forEach((id, i) => {
      mergedMap.set(id, {
        confidence: (existingConfidences[i] || 0) * historyWeight,
        coOccurrenceCount: existingCounts[i] || 0,
      });
    });

    // Apply new data
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

    // Sort by merged confidence, keep top 10
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
  }

  console.log(`Merge complete: ${created} created, ${updated} updated.`);
  return { created, updated };
}

// Main incremental training function
export async function runIncrementalTraining(admin) {
  const startTime = Date.now();

  // Get settings
  const settingsRows = await prisma.setting.findMany();
  const settings = Object.fromEntries(settingsRows.map((s) => [s.key, s.value]));
  const historyWeight = Number(settings["history_weight"] ?? 0.8);
  const newDataWeight = Number(settings["new_data_weight"] ?? 0.2);
  const trainingDateRange = settings["training_date_range"] ?? "all";

  // Determine since date
  let sinceDate;
  if (trainingDateRange === "3m") {
    sinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  } else if (trainingDateRange === "6m") {
    sinceDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  } else if (trainingDateRange === "12m") {
    sinceDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  } else {
    // Use last incremental training date, or 30 days ago as fallback
    const lastIncremental = await prisma.trainingLog.findFirst({
      where: { triggeredBy: "manual", status: "success" },
      orderBy: { createdAt: "desc" },
    });
    sinceDate = lastIncremental
      ? new Date(lastIncremental.createdAt)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }

  let ordersCount = 0;

  try {
    // Sync SKU to handle mapping
    const { syncSkuToHandle } = await import("./sync-sku-handle.server.js");
    await syncSkuToHandle(admin);

    // Fetch new orders from Shopify
    const newOrders = await fetchNewOrders(admin, sinceDate);
    ordersCount = newOrders.length;

    if (ordersCount === 0) {
      console.log("No new orders found, skipping training.");
      await prisma.trainingLog.create({
        data: {
          triggeredBy: "manual",
          ordersCount: 0,
          status: "success",
          durationMs: Date.now() - startTime,
          errorMsg: "No new orders found.",
        },
      });
      return { success: true, ordersCount: 0, message: "No new orders found." };
    }

    // Save orders to database
    await saveOrders(newOrders);

    // Build baskets and run Apriori
    const baskets = newOrders.map((o) => o.skus);
    const newRecs = buildRecommendations(baskets, {
      minSupport: 2, // lower threshold for incremental (smaller dataset)
      minConfidence: 0.01,
      topN: 10,
    });

    // Merge with existing recommendations
    const { created, updated } = await mergeRecommendations(
      newRecs,
      historyWeight,
      newDataWeight
    );

    // Log success
    await prisma.trainingLog.create({
      data: {
        triggeredBy: "manual",
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
      message: `Incremental training complete. ${ordersCount} orders processed, ${created} new mappings, ${updated} updated.`,
    };
  } catch (err) {
    console.error("Incremental training failed:", err);
    await prisma.trainingLog.create({
      data: {
        triggeredBy: "manual",
        ordersCount,
        status: "failed",
        durationMs: Date.now() - startTime,
        errorMsg: err.message,
      },
    });
    return { success: false, message: err.message };
  }
}