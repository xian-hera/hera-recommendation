/**
 * Recommendation API endpoint
 * GET /api/recommend?shop=xxx&product=SKU-A&customer=123
 * Returns product handles instead of SKUs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const productSku = url.searchParams.get("product");
  const customerId = url.searchParams.get("customer");

  if (!shop || !productSku) {
    return Response.json(
      { error: "Missing required params: shop, product" },
      { status: 400 }
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

    // Get recommendations for current product (browse signal)
    const browseRec = await prisma.recommendation.findUnique({
      where: { productId: productSku },
    });

    const browseScores = new Map();
    if (browseRec?.recommendedIds) {
      const ids = browseRec.recommendedIds;
      const confidences = browseRec.confidence;
      ids.forEach((id, i) => {
        browseScores.set(id, (confidences[i] || 0) * browseWeight);
      });
    }

    // Get recommendations based on customer's last order (purchase signal)
    const purchaseScores = new Map();
    if (customerId) {
      const lastOrder = await prisma.order.findFirst({
        where: { customerId: String(customerId) },
        orderBy: { createdAt: "desc" },
      });

      if (lastOrder?.productIds) {
        const lastSkus = lastOrder.productIds;
        for (const sku of lastSkus) {
          const rec = await prisma.recommendation.findUnique({
            where: { productId: sku },
          });
          if (rec?.recommendedIds) {
            rec.recommendedIds.forEach((id, i) => {
              const score = (rec.confidence[i] || 0) * purchaseWeight;
              purchaseScores.set(id, (purchaseScores.get(id) || 0) + score);
            });
          }
        }
      }
    }

    // Merge scores
    const merged = new Map();
    for (const [id, score] of browseScores) {
      merged.set(id, (merged.get(id) || 0) + score);
    }
    for (const [id, score] of purchaseScores) {
      merged.set(id, (merged.get(id) || 0) + score);
    }

    // Remove current product
    merged.delete(productSku);

    // Sort and take top N
    const topSkus = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, recommendCount)
      .map(([sku]) => sku);

    // Convert SKUs to handles
    const skuMappings = await prisma.skuToHandle.findMany({
      where: { sku: { in: topSkus } },
    });

    const skuToHandleMap = Object.fromEntries(
      skuMappings.map((m) => [m.sku, { handle: m.handle, title: m.title }])
    );

    // Build final results, preserving score order
    const results = topSkus
      .filter((sku) => skuToHandleMap[sku])
      .map((sku) => ({
        sku,
        handle: skuToHandleMap[sku].handle,
        title: skuToHandleMap[sku].title,
        score: Math.round((merged.get(sku) || 0) * 1000) / 1000,
      }));

    return Response.json({
      product: productSku,
      customer: customerId || null,
      recommendations: results,
    });
  } catch (err) {
    console.error("Recommendation API error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
};