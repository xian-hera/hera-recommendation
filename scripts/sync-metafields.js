/**
 * Local metafield sync script
 * Usage: node scripts/sync-metafields.js
 * Uses GraphQL bulk mutations for faster and more stable writes
 */

import pg from "pg";
import * as dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Write metafields for a batch of products via GraphQL
async function setMetafieldsBatch(shop, accessToken, items) {
  const metafields = items.map((item) => ({
    ownerId: item.productId,
    namespace: "custom",
    key: "hera_recommendations",
    type: "json",
    value: JSON.stringify(item.handles),
  }));

  const response = await fetch(
    `https://${shop}/admin/api/2024-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `
          mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id key }
              userErrors { field message }
            }
          }
        `,
        variables: { metafields },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  const userErrors = data.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    console.error("GraphQL user errors:", userErrors);
  }

  return data.data?.metafieldsSet?.metafields?.length || 0;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // Get shop and access token
    const sessionResult = await pool.query(
      `SELECT shop, "accessToken" FROM "Session" WHERE "isOnline" = false ORDER BY expires DESC LIMIT 1`
    );

    if (sessionResult.rows.length === 0) {
      console.error("No session found. Make sure the app is installed.");
      process.exit(1);
    }

    const { shop, accessToken } = sessionResult.rows[0];
    console.log(`Using shop: ${shop}`);

    // Load all recommendations
    const recsResult = await pool.query(
      `SELECT product_id, recommended_ids FROM recommendations`
    );
    console.log(`Total recommendations to sync: ${recsResult.rows.length}`);

    // Load SKU to handle + product ID mapping
    const mappingResult = await pool.query(
      `SELECT sku, handle, product_id FROM sku_to_handle WHERE product_id IS NOT NULL`
    );
    const skuToProductMap = {};
    for (const row of mappingResult.rows) {
      skuToProductMap[row.sku] = { handle: row.handle, productId: row.product_id };
    }
    console.log(`Loaded ${mappingResult.rows.length} SKU mappings`);

    // Build items to sync
    const items = [];
    for (const rec of recsResult.rows) {
      const sourceMapping = skuToProductMap[rec.product_id];
      if (!sourceMapping?.productId) continue;

      const recommendedHandles = rec.recommended_ids
        .map((sku) => skuToProductMap[sku]?.handle)
        .filter(Boolean);

      if (recommendedHandles.length === 0) continue;

      items.push({
        productId: sourceMapping.productId,
        handles: recommendedHandles,
      });
    }

    console.log(`Items to sync: ${items.length}`);

    // Process in batches of 25
    const batchSize = 25;
    let synced = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      try {
        const count = await setMetafieldsBatch(shop, accessToken, batch);
        synced += count;
      } catch (err) {
        console.error(`Batch ${i / batchSize + 1} failed:`, err.message);
        failed += batch.length;
      }

      // Rate limiting: 1 batch per second
      await sleep(1000);

      if (synced % 500 === 0 && synced > 0) {
        console.log(`Progress: ${synced} / ${items.length} | Failed: ${failed}`);
      }
    }

    console.log(`\n✅ Metafield sync complete!`);
    console.log(`   Synced: ${synced}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Total: ${items.length}`);

  } catch (err) {
    console.error("Sync failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();