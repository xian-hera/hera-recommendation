/**
 * Recommendation API endpoint
 * GET /api/recommend?shop=xxx&product=SKU&customer=yyy&viewed=productId1,productId2
 *
 * - product: current product SKU (product page)
 * - customer: Shopify customer ID (for purchase history)
 * - viewed: comma-separated Shopify product IDs from localStorage (homepage)
 */

import { PrismaClient } from "@prisma/client";
import { unauthenticated } from "../shopify.server.js";

const prisma = new PrismaClient();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Handle CORS preflight
export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return new Response(null, { status: 405 });
};

// Get SKUs from Shopify product IDs via Admin API
async function getSkusFromProductIds(admin, productIds) {
  if (!productIds || productIds.length === 0) return [];

  const skus = [];
  const batches = [];
  for (let i = 0; i < productIds.length; i += 10) {
    batches.push(productIds.slice(i, i + 10));
  }

  for (const batch of batches) {
    const query = `
      query getProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            variants(first: 10) {
              edges {
                node {
                  sku
                }
              }
            }
          }
        }
      }
    `;

    const gids = batch.map((id) => `gid://shopify/Product/${id}`);
    const response = await admin.graphql(query, {
      variables: { ids: gids },
    });
    const data = await response.json();

    for (const node of data.data?.nodes || []) {
      if (!node?.variants) continue;
      for (const edge of node.variants.edges) {
        const sku = edge.node.sku?.trim();
        if (sku) skus.push(sku);
      }
    }
  }

  return skus;
}

// Get SKUs from customer's last order via Admin API
async function getLastOrderSkus(admin, customerId) {
  const query = `
    query getCustomerOrders($customerId: ID!) {
      customer(id: $customerId) {
        orders(first: 1, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              lineItems(first: 50) {
                edges {
                  node {
                    variant {
                      sku
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const gid = customerId.includes("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  const response = await admin.graphql(query, {
    variables: { customerId: gid },
  });
  const data = await response.json();

  const orders = data.data?.customer?.orders?.edges || [];
  if (orders.length === 0) return [];

  const skus = orders[0].node.lineItems.edges
    .map((e) => e.node.variant?.sku?.trim())
    .filter(Boolean);

  const shuffled = skus.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 2);
}

// Score SKUs from recommendation table
async function scoreSkus(skus, weight) {
  const scores = new Map();
  for (const sku of skus) {
    const rec = await prisma.recommendation.findUnique({
      where: { productId: sku },
    });
    if (rec?.recommendedIds) {
      rec.recommendedIds.forEach((id, i) => {
        const score = (rec.confidence[i] || 0) * weight;
        scores.set(id, (scores.get(id) || 0) + score);
      });
    }
  }
  return scores;
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const productSku = url.searchParams.get("product");
  const customerId = url.searchParams.get("customer");
  const viewedParam = url.searchParams.get("viewed");

  if (!shop) {
    return Response.json(
      { error: "Missing required param: shop" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    // Get settings
    const settingsRows = await prisma.setting.findMany();
    const settings = Object.fromEntries(
      settingsRows.map((s) => [s.key, s.value])
    );
    const recommendCount = Number(settings["recommendation_count"] ?? 4);
    const browseWeight = Number(settings["browse_weight"] ?? 0.4);
    const purchaseWeight = Number(settings["purchase_weight"] ?? 0.6);

    // Get Shopify Admin API client
    const { admin } = await unauthenticated.admin(shop);

    const merged = new Map();

    // Signal 1: current product SKU (product page)
    if (productSku) {
      const scores = await scoreSkus([productSku], browseWeight);
      for (const [id, score] of scores) {
        merged.set(id, (merged.get(id) || 0) + score);
      }
    }

    // Signal 2: recently viewed product IDs from localStorage
    if (viewedParam) {
      const viewedIds = viewedParam
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 5);

      const viewedSkus = await getSkusFromProductIds(admin, viewedIds);
      const scores = await scoreSkus(viewedSkus, browseWeight);
      for (const [id, score] of scores) {
        merged.set(id, (merged.get(id) || 0) + score);
      }
    }

    // Signal 3: customer last order (2 random SKUs)
    if (customerId) {
      const lastOrderSkus = await getLastOrderSkus(admin, customerId);
      const scores = await scoreSkus(lastOrderSkus, purchaseWeight);
      for (const [id, score] of scores) {
        merged.set(id, (merged.get(id) || 0) + score);
      }
    }

    // Remove current product from results
    if (productSku) merged.delete(productSku);

    // Sort and take top N
    let topSkus = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, recommendCount)
      .map(([sku]) => sku);

    // Fallback: fill remaining slots with highest-confidence recommended products globally
    if (topSkus.length < recommendCount) {
      const needed = recommendCount - topSkus.length;
      const existing = new Set(topSkus);

      const topRecs = await prisma.$queryRaw`
        SELECT r.recommended_ids->>0 as top_sku, r.confidence[1] as top_confidence
        FROM recommendations r
        INNER JOIN sku_to_handle s ON s.sku = (r.recommended_ids->>0)
        WHERE jsonb_array_length(r.recommended_ids) > 0
          AND r.confidence[1] IS NOT NULL
        ORDER BY r.confidence[1] DESC
        LIMIT ${needed * 10}
      `;

      for (const rec of topRecs) {
        if (topSkus.length >= recommendCount) break;
        const sku = rec.top_sku;
        if (!sku || existing.has(sku)) continue;
        topSkus.push(sku);
        existing.add(sku);
      }
    }

    // Convert SKUs to handles
    const skuMappings = await prisma.skuToHandle.findMany({
      where: { sku: { in: topSkus } },
    });

    const skuToHandleMap = Object.fromEntries(
      skuMappings.map((m) => [m.sku, { handle: m.handle, title: m.title }])
    );

    // Deduplicate by handle
    const seenHandles = new Set();
    const results = topSkus
      .filter((sku) => skuToHandleMap[sku])
      .map((sku) => ({
        sku,
        handle: skuToHandleMap[sku].handle,
        title: skuToHandleMap[sku].title,
        score: Math.round((merged.get(sku) || 0) * 1000) / 1000,
      }))
      .filter((item) => {
        if (seenHandles.has(item.handle)) return false;
        seenHandles.add(item.handle);
        return true;
      });

    return Response.json(
      {
        product: productSku || null,
        customer: customerId || null,
        recommendations: results,
      },
      { headers: corsHeaders }
    );
  } catch (err) {
    console.error("Recommendation API error:", err);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
};