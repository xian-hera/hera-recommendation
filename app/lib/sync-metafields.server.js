/**
 * Sync recommendation results to Shopify product metafields
 * Called after training completes
 * Writes recommended product handles to custom.hera_recommendations
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Write metafield for a single product
async function setProductMetafield(admin, productId, handles) {
  const response = await admin.graphql(`
    mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    variables: {
      metafields: [{
        ownerId: productId,
        namespace: "custom",
        key: "hera_recommendations",
        type: "json",
        value: JSON.stringify(handles),
      }],
    },
  });

  const data = await response.json();
  const errors = data.data?.metafieldsSet?.userErrors;
  if (errors && errors.length > 0) {
    console.error(`Metafield error for ${productId}:`, errors);
    return false;
  }
  return true;
}

// Rate limiter
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main function: sync all recommendations to product metafields
 * @param {object} admin - Shopify admin API client
 */
export async function syncMetafields(admin) {
  console.log("Starting metafield sync...");
  const startTime = Date.now();

  // Load all recommendations from database
  const recommendations = await prisma.recommendation.findMany();
  console.log(`Total recommendations to sync: ${recommendations.length}`);

  // Load SKU to handle+productId mapping
  const skuMappings = await prisma.skuToHandle.findMany({
    where: { productId: { not: null } },
  });
  const skuToProductMap = Object.fromEntries(
    skuMappings.map((m) => [m.sku, { handle: m.handle, productId: m.productId }])
  );

  // Build handle to productId map for quick lookup
  const handleToProductId = Object.fromEntries(
    skuMappings.map((m) => [m.handle, m.productId])
  );

  let synced = 0;
  let failed = 0;
  let requestCount = 0;

  for (const rec of recommendations) {
    const sourceMapping = skuToProductMap[rec.productId];
    if (!sourceMapping?.productId) {
      failed++;
      continue;
    }

    // Convert recommended SKUs to handles, filter out unmapped
    const recommendedHandles = rec.recommendedIds
      .map((sku) => skuToProductMap[sku]?.handle)
      .filter(Boolean);

    if (recommendedHandles.length === 0) {
      failed++;
      continue;
    }

    const success = await setProductMetafield(
      admin,
      sourceMapping.productId,
      recommendedHandles
    );

    if (success) {
      synced++;
    } else {
      failed++;
    }

    requestCount++;

    // Rate limiting: 5 requests per second
    if (requestCount % 5 === 0) {
      await sleep(1000);
    }

    if (synced % 500 === 0 && synced > 0) {
      console.log(`Progress: ${synced} / ${recommendations.length}`);
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`Metafield sync complete: ${synced} synced, ${failed} failed, ${duration}s`);
  return { synced, failed, duration };
}