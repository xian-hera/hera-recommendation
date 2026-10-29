/**
 * Recommendation API endpoint
 * GET /api/recommend?shop=xxx&product=SKU&customer=yyy&viewed=productId1,productId2&count=N
 *
 * - product: current product SKU (product page)
 * - customer: Shopify customer ID (for purchase history)
 * - viewed: comma-separated Shopify product IDs from localStorage (homepage)
 * - count: optional, how many items the caller wants to display. This is a
 *   per-request override on top of the admin "Number of recommendations to
 *   show" setting — whichever is larger wins, so a theme section configured
 *   to show more than the app-wide default still gets enough candidates.
 *
 * 2026-10-29 performance pass (requests were taking 3.5–8.6 s in Render logs):
 *   - the site-wide "popular products" fallback and the settings are cached
 *     in memory (lib/recommend-cache.server.js) instead of re-running a
 *     full-table aggregate on every call;
 *   - scoreSkus loads all source SKUs in ONE query instead of one per SKU;
 *   - the three signals run in parallel, and the Shopify Admin client is
 *     only created when a signal actually needs Shopify (viewed / customer);
 * Only SKUs present in sku_to_handle (= ACTIVE products, see
 * sync-sku-handle.server.js) can ever be returned.
 */

import prisma from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";
import { getSettingsCached, getPopularPoolCached } from "../lib/recommend-cache.server.js";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// How many extra unique products to return beyond the target display count.
// The storefront can then skip any product that turns out to be unavailable
// (draft/hidden/deleted) without ending up short — see the theme-side JS.
const RETURN_BUFFER = 3;

// Sane ceiling for a caller-supplied `count`, so a bad/malicious value can't
// force a huge fallback query.
const MAX_REQUESTED_COUNT = 20;

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

// Score SKUs from recommendation table. Association rules whose own
// confidence falls below minConfidence are skipped entirely — this is the
// admin-configurable "Minimum confidence threshold" from the Settings page,
// which previously existed in the UI but was never actually read here.
async function scoreSkus(skus, weight, minConfidence = 0) {
  const scores = new Map();
  const unique = [...new Set(skus)];
  if (unique.length === 0) return scores;
  const rows = await prisma.recommendation.findMany({
    where: { productId: { in: unique } },
    select: { productId: true, recommendedIds: true, confidence: true },
  });
  const bySku = new Map(rows.map((r) => [r.productId, r]));
  // Iterate the caller's list (not the unique set) so a SKU passed twice
  // still counts twice, exactly as before.
  for (const sku of skus) {
    const rec = bySku.get(sku);
    if (!Array.isArray(rec?.recommendedIds)) continue;
    rec.recommendedIds.forEach((id, i) => {
      const confidence = rec.confidence[i] || 0;
      if (confidence < minConfidence) return;
      const score = confidence * weight;
      scores.set(id, (scores.get(id) || 0) + score);
    });
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
  const requestedCountParam = url.searchParams.get("count");

  if (!shop) {
    return Response.json(
      { error: "Missing required param: shop" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    // Get settings (cached, see lib/recommend-cache.server.js)
    const settings = await getSettingsCached();
    const recommendCount = Number(settings["recommendation_count"] ?? 4);
    const browseWeight = Number(settings["browse_weight"] ?? 0.4);
    const purchaseWeight = Number(settings["purchase_weight"] ?? 0.6);
    // NOTE: the admin "Minimum confidence threshold" setting is still NOT
    // applied here (unchanged behaviour). Stored confidences are weighted
    // by the history/new-data merge, so turning it on would silently drop
    // many rules — enable deliberately if wanted.
    const minConfidence = 0;

    // A theme section can be configured to show more items than the app's
    // global "Number of recommendations to show" setting. Respect whichever
    // is larger so the storefront never asks for more than we try to supply.
    const requestedCount = Number(requestedCountParam);
    const displayCount =
      Number.isFinite(requestedCount) && requestedCount > 0
        ? Math.max(recommendCount, Math.min(requestedCount, MAX_REQUESTED_COUNT))
        : recommendCount;

    // Total distinct products we try to gather. We deliberately gather more
    // than displayCount (see RETURN_BUFFER) so the frontend has spare,
    // already-ranked candidates to fall back on if a product turns out to be
    // unavailable when it fetches the product detail.
    const targetCount = displayCount + RETURN_BUFFER;

    const viewedIds = viewedParam
      ? viewedParam
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

    // Shopify Admin API client — only needed for the viewed / customer
    // signals, so plain calls (no signals) skip it entirely.
    let adminPromise = null;
    const getAdmin = () => {
      if (!adminPromise) adminPromise = unauthenticated.admin(shop).then((r) => r.admin);
      return adminPromise;
    };

    // The three signals are independent — run them in parallel.
    const signalJobs = [];

    // Signal 1: current product SKU (product page)
    if (productSku) {
      signalJobs.push(scoreSkus([productSku], browseWeight, minConfidence));
    }

    // Signal 2: recently viewed product IDs from localStorage
    if (viewedIds.length > 0) {
      signalJobs.push(
        getAdmin()
          .then((admin) => getSkusFromProductIds(admin, viewedIds))
          .then((viewedSkus) => scoreSkus(viewedSkus, browseWeight, minConfidence))
      );
    }

    // Signal 3: customer last order (2 random SKUs)
    if (customerId) {
      signalJobs.push(
        getAdmin()
          .then((admin) => getLastOrderSkus(admin, customerId))
          .then((lastOrderSkus) => scoreSkus(lastOrderSkus, purchaseWeight, minConfidence))
      );
    }

    const merged = new Map();
    for (const scores of await Promise.all(signalJobs)) {
      for (const [id, score] of scores) {
        merged.set(id, (merged.get(id) || 0) + score);
      }
    }

    // Drop the exact SKU of the current product. Its sibling variants
    // (other shades/sizes of the same product) are excluded further down
    // once we know the product's handle.
    if (productSku) merged.delete(productSku);

    // Look up handles for every candidate SKU, plus the current product's
    // own SKU (so we can exclude ALL of its variants, not just this one
    // SKU, from the results).
    const candidateSkus = [...merged.keys()];
    const lookupSkus = productSku
      ? [...new Set([...candidateSkus, productSku])]
      : candidateSkus;

    const skuMappings = lookupSkus.length
      ? await prisma.skuToHandle.findMany({
          where: { sku: { in: lookupSkus } },
        })
      : [];
    const skuToHandleMap = Object.fromEntries(
      skuMappings.map((m) => [m.sku, { handle: m.handle, title: m.title }])
    );

    const currentHandle = productSku
      ? skuToHandleMap[productSku]?.handle ?? null
      : null;

    // Walk the fully-ranked candidate list ONCE, deduplicating by product
    // handle as we go — a product can have several SKUs (one per
    // variant/shade), and we only ever want to show it once. This replaces
    // the previous approach of slicing to N SKUs first and deduplicating by
    // handle afterwards, which is what let the storefront end up with far
    // fewer items than configured: several of the top-N SKUs would collapse
    // onto the same handle, and nothing filled the resulting gap.
    const seenHandles = new Set();
    const results = [];

    const sortedCandidates = [...merged.entries()].sort((a, b) => b[1] - a[1]);
    for (const [sku, score] of sortedCandidates) {
      if (results.length >= targetCount) break;

      const mapping = skuToHandleMap[sku];
      if (!mapping) continue; // SKU not synced to a handle yet — skip it
      const { handle, title } = mapping;
      if (handle === currentHandle) continue; // don't recommend the product itself
      if (seenHandles.has(handle)) continue; // another variant of a product we already picked

      seenHandles.add(handle);
      results.push({
        sku,
        handle,
        title,
        score: Math.round(score * 1000) / 1000,
      });
    }

    // Fallback: if personalized signals didn't produce enough distinct
    // products, fill the rest from the site-wide "most frequently
    // recommended" pool (products that show up most often across all
    // trained association rules — a proxy for popularity, not a literal
    // Shopify best-sellers report). Already one row per product handle and
    // active-only; cached in memory (see lib/recommend-cache.server.js).
    if (results.length < targetCount) {
      const pool = await getPopularPoolCached();
      for (const row of pool) {
        if (results.length >= targetCount) break;
        const { handle, sku, title } = row;
        if (!handle || handle === currentHandle || seenHandles.has(handle)) {
          continue;
        }
        seenHandles.add(handle);
        results.push({ sku, handle, title, score: 0 });
      }
      // If the catalog genuinely doesn't have enough eligible products left,
      // we fall through with fewer than targetCount — there's nothing left
      // to backfill with, and the storefront will just show what it got.
    }

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
